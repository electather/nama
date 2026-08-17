package api

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

const (
	h2ClientPreface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

	h2FrameData      = 0x0
	h2FrameHeaders   = 0x1
	h2FrameRSTStream = 0x3
	h2FrameSettings  = 0x4

	h2FlagEndStream  = 0x1
	h2FlagAck        = 0x1
	h2FlagEndHeaders = 0x4

	h2ErrCodeRefusedStream = 0x7
)

func TestNewClientsPreventHTTP2AutomaticMutationReplay(t *testing.T) {
	calls := []struct {
		name string
		call func(context.Context, *Clients) error
	}{
		{
			name: "CreateAdministrator",
			call: func(ctx context.Context, clients *Clients) error {
				_, err := clients.Setup.CreateAdministrator(ctx, connect.NewRequest(&apiv1.CreateAdministratorRequest{
					BootstrapToken: "bootstrap-token",
					DisplayName:    "Ada Lovelace",
					Email:          "ada@example.com",
					Password:       "setup password",
				}))
				return err
			},
		},
		{
			name: "SignIn",
			call: func(ctx context.Context, clients *Clients) error {
				_, err := clients.Auth.SignIn(ctx, connect.NewRequest(&apiv1.SignInRequest{
					Email:    "ada@example.com",
					Password: "sign-in password",
				}))
				return err
			},
		},
	}

	for _, test := range calls {
		t.Run(test.name, func(t *testing.T) {
			server := newHTTP2ReplayServer(t)
			httpClient := server.Client(t)
			transport, ok := httpClient.Transport.(*http.Transport)
			if !ok {
				t.Fatalf("test HTTP client transport = %T, want *http.Transport", httpClient.Transport)
			}
			if !transport.ForceAttemptHTTP2 {
				t.Fatal("test HTTP client does not attempt HTTP/2")
			}
			callerTransport := httpClient.Transport
			callerRedirectErr := errors.New("caller redirect policy")
			httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
				return callerRedirectErr
			}
			assertCallerState := func() {
				if got := httpClient.Transport; got != callerTransport {
					t.Error("NewClients() replaced the caller-owned transport")
				}
				if !transport.ForceAttemptHTTP2 {
					t.Error("NewClients() changed the caller-owned transport HTTP/2 setting")
				}
				if err := httpClient.CheckRedirect(nil, nil); !errors.Is(err, callerRedirectErr) {
					t.Errorf("NewClients() changed the caller-owned redirect policy: got %v, want %v", err, callerRedirectErr)
				}
			}

			clients, err := NewClients(httpClient, server.URL(), "")
			if err != nil {
				t.Fatalf("NewClients() error = %v", err)
			}
			assertCallerState()

			callErr := test.call(t.Context(), clients)
			if callErr == nil {
				t.Fatal("mutation call error = nil, want test server failure")
			}
			assertCallerState()
			attempts := server.Attempts()
			http2Attempts := server.HTTP2Attempts()
			if attempts == 1 && http2Attempts != 0 {
				t.Fatal("test server did not provoke the HTTP/2 automatic replay")
			}
			if attempts != 1 {
				if http2Attempts == 0 {
					t.Fatalf("test server observed %d mutation attempts without HTTP/2; call failed before the fixture observed a request: %v", attempts, callErr)
				}
				t.Errorf("outbound mutation attempts = %d, want exactly 1; HTTP/2 replayed the mutation after the server observed it", attempts)
			}
		})
	}
}

type http2ReplayServer struct {
	listener net.Listener
	client   *http.Client

	attempts      atomic.Int32
	http2Attempts atomic.Int32

	connectionsMu sync.Mutex
	connections   map[net.Conn]struct{}
	closing       bool
	closeOnce     sync.Once
	wait          sync.WaitGroup
}

func newHTTP2ReplayServer(t *testing.T) *http2ReplayServer {
	t.Helper()

	certificateServer := httptest.NewUnstartedServer(http.NotFoundHandler())
	certificateServer.EnableHTTP2 = true
	certificateServer.StartTLS()
	t.Cleanup(certificateServer.Close)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for HTTP/2 replay server: %v", err)
	}
	tlsConfig := certificateServer.TLS.Clone()
	tlsConfig.NextProtos = []string{"h2", "http/1.1"}
	server := &http2ReplayServer{
		listener:    tls.NewListener(listener, tlsConfig),
		client:      certificateServer.Client(),
		connections: make(map[net.Conn]struct{}),
	}
	server.wait.Go(server.serve)
	t.Cleanup(server.Close)
	return server
}

func (server *http2ReplayServer) Client(t *testing.T) *http.Client {
	t.Helper()
	return server.client
}

func (server *http2ReplayServer) URL() string {
	return "https://" + server.listener.Addr().String()
}

func (server *http2ReplayServer) Attempts() int32 {
	return server.attempts.Load()
}

func (server *http2ReplayServer) HTTP2Attempts() int32 {
	return server.http2Attempts.Load()
}

func (server *http2ReplayServer) Close() {
	server.closeOnce.Do(func() {
		_ = server.listener.Close()

		server.connectionsMu.Lock()
		server.closing = true
		connections := slices.Collect(maps.Keys(server.connections))
		server.connectionsMu.Unlock()
		for _, connection := range connections {
			_ = connection.Close()
		}
		server.wait.Wait()
	})
}

func (server *http2ReplayServer) serve() {
	for {
		connection, err := server.listener.Accept()
		if err != nil {
			return
		}
		server.connectionsMu.Lock()
		if server.closing {
			server.connectionsMu.Unlock()
			_ = connection.Close()
			return
		}
		server.connections[connection] = struct{}{}
		server.connectionsMu.Unlock()
		server.wait.Go(func() {
			defer func() {
				server.connectionsMu.Lock()
				delete(server.connections, connection)
				server.connectionsMu.Unlock()
				_ = connection.Close()
			}()
			server.serveConnection(connection)
		})
	}
}

func (server *http2ReplayServer) serveConnection(connection net.Conn) {
	tlsConnection, ok := connection.(*tls.Conn)
	if !ok {
		return
	}
	if err := tlsConnection.Handshake(); err != nil {
		return
	}
	if tlsConnection.ConnectionState().NegotiatedProtocol == "h2" {
		server.serveHTTP2(tlsConnection)
		return
	}
	server.serveHTTP1(tlsConnection)
}

func (server *http2ReplayServer) serveHTTP1(connection net.Conn) {
	request, err := http.ReadRequest(bufio.NewReader(connection))
	if err != nil {
		return
	}
	defer request.Body.Close()
	if _, err := io.Copy(io.Discard, request.Body); err != nil {
		return
	}
	server.attempts.Add(1)
	_, _ = io.WriteString(connection, "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

func (server *http2ReplayServer) serveHTTP2(connection net.Conn) {
	preface := make([]byte, len(h2ClientPreface))
	if _, err := io.ReadFull(connection, preface); err != nil || string(preface) != h2ClientPreface {
		return
	}
	if err := writeHTTP2Frame(connection, h2FrameSettings, 0, 0, nil); err != nil {
		return
	}

	openStreams := make(map[uint32]struct{})
	for {
		frameType, flags, streamID, _, err := readHTTP2Frame(connection)
		if err != nil {
			return
		}
		switch frameType {
		case h2FrameSettings:
			if flags&h2FlagAck == 0 {
				if err := writeHTTP2Frame(connection, h2FrameSettings, h2FlagAck, 0, nil); err != nil {
					return
				}
			}
		case h2FrameHeaders:
			if flags&h2FlagEndStream != 0 {
				if !server.respondToHTTP2Mutation(connection, streamID) {
					return
				}
			} else {
				openStreams[streamID] = struct{}{}
			}
		case h2FrameData:
			if flags&h2FlagEndStream != 0 {
				if _, ok := openStreams[streamID]; ok {
					delete(openStreams, streamID)
					if !server.respondToHTTP2Mutation(connection, streamID) {
						return
					}
				}
			}
		}
	}
}

func (server *http2ReplayServer) respondToHTTP2Mutation(connection net.Conn, streamID uint32) bool {
	server.http2Attempts.Add(1)
	if server.attempts.Add(1) == 1 {
		var payload [4]byte
		binary.BigEndian.PutUint32(payload[:], h2ErrCodeRefusedStream)
		return writeHTTP2Frame(connection, h2FrameRSTStream, 0, streamID, payload[:]) == nil
	}
	return writeHTTP2Frame(connection, h2FrameHeaders, h2FlagEndStream|h2FlagEndHeaders, streamID, []byte{0x8e}) == nil
}

func readHTTP2Frame(reader io.Reader) (byte, byte, uint32, []byte, error) {
	var header [9]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, 0, 0, nil, err
	}
	length := int(header[0])<<16 | int(header[1])<<8 | int(header[2])
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, 0, 0, nil, err
	}
	return header[3], header[4], binary.BigEndian.Uint32(header[5:]) & 0x7fffffff, payload, nil
}

func writeHTTP2Frame(writer io.Writer, frameType, flags byte, streamID uint32, payload []byte) error {
	var header [9]byte
	length := len(payload)
	header[0] = byte(length >> 16)
	header[1] = byte(length >> 8)
	header[2] = byte(length)
	header[3] = frameType
	header[4] = flags
	binary.BigEndian.PutUint32(header[5:], streamID&0x7fffffff)
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}
