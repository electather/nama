package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

func TestNewClientsRejectRedirectsWithoutReplayingRequests(t *testing.T) {
	for _, redirectStatus := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		t.Run(http.StatusText(redirectStatus), func(t *testing.T) {
			var sourceRequests atomic.Int32
			var targetRequests atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				targetRequests.Add(1)
			}))
			t.Cleanup(target.Close)
			source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				sourceRequests.Add(1)
				writer.Header().Set("Location", target.URL+request.URL.RequestURI())
				writer.WriteHeader(redirectStatus)
			}))
			t.Cleanup(source.Close)

			clients, err := NewClients(source.Client(), source.URL, "stored-session-bearer")
			if err != nil {
				t.Fatalf("NewClients() error = %v", err)
			}

			calls := []struct {
				name string
				call func(context.Context) error
			}{
				{
					name: "CreateAdministrator",
					call: func(ctx context.Context) error {
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
					call: func(ctx context.Context) error {
						_, err := clients.Auth.SignIn(ctx, connect.NewRequest(&apiv1.SignInRequest{
							Email:    "ada@example.com",
							Password: "sign-in password",
						}))
						return err
					},
				},
				{
					name: "GetCurrentUser",
					call: func(ctx context.Context) error {
						_, err := clients.Auth.GetCurrentUser(ctx, connect.NewRequest(&apiv1.GetCurrentUserRequest{}))
						return err
					},
				},
				{
					name: "SignOut",
					call: func(ctx context.Context) error {
						_, err := clients.Auth.SignOut(ctx, connect.NewRequest(&apiv1.SignOutRequest{}))
						return err
					},
				},
			}
			for _, call := range calls {
				t.Run(call.name, func(t *testing.T) {
					sourceRequests.Store(0)
					targetRequests.Store(0)

					err := call.call(t.Context())
					if err == nil {
						t.Fatal("redirected request error = nil, want safe client error")
					}
					connectErr, ok := errors.AsType[*connect.Error](err)
					if !ok {
						t.Fatalf("redirected request error = %T, want *connect.Error", err)
					}
					if got := connectErr.Code(); got != connect.CodeUnknown {
						t.Errorf("redirected request error code = %v, want %v", got, connect.CodeUnknown)
					}
					if got := sourceRequests.Load(); got != 1 {
						t.Errorf("redirect source request count = %d, want 1", got)
					}
					if got := targetRequests.Load(); got != 0 {
						t.Errorf("redirect target request count = %d, want 0", got)
					}
				})
			}
		})
	}
}

func TestNewClientsBypassesEnvironmentProxyOnlyForPlainHTTP(t *testing.T) {
	var proxyRequests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		proxyRequests.Add(1)
		writer.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(proxy.Close)
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("https_proxy", "")
	t.Setenv("no_proxy", "")

	var directRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		directRequests.Add(1)
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(target.Close)

	const privateTarget = "10.0.0.1:8080"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(request *http.Request) (*url.URL, error) {
		name := "HTTP_PROXY"
		if request.URL.Scheme == "https" {
			name = "HTTPS_PROXY"
		}
		return url.Parse(os.Getenv(name))
	}
	var dialer net.Dialer
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == privateTarget {
			address = target.Listener.Addr().String()
		}
		return dialer.DialContext(ctx, network, address)
	}
	targetURL := "http://" + privateTarget
	httpClient := &http.Client{Transport: transport}
	clients, err := NewClients(httpClient, targetURL, "stored-session-bearer")
	if err != nil {
		t.Fatalf("NewClients() error = %v", err)
	}

	requests := []func(){
		func() {
			_, _ = clients.Setup.CreateAdministrator(t.Context(), connect.NewRequest(&apiv1.CreateAdministratorRequest{
				BootstrapToken: "bootstrap-token",
				DisplayName:    "Ada Lovelace",
				Email:          "ada@example.com",
				Password:       "setup password",
			}))
		},
		func() {
			_, _ = clients.Auth.SignIn(t.Context(), connect.NewRequest(&apiv1.SignInRequest{
				Email:    "ada@example.com",
				Password: "sign-in password",
			}))
		},
		func() {
			_, _ = clients.Auth.GetCurrentUser(t.Context(), connect.NewRequest(&apiv1.GetCurrentUserRequest{}))
		},
	}
	for _, request := range requests {
		request()
	}

	if got := proxyRequests.Load(); got != 0 {
		t.Errorf("plain HTTP proxy request count = %d, want 0", got)
	}
	if got, want := directRequests.Load(), int32(len(requests)); got != want {
		t.Errorf("plain HTTP direct request count = %d, want %d", got, want)
	}
	if httpClient.Transport != transport {
		t.Error("NewClients() replaced the caller-owned transport")
	}
	if transport.Proxy == nil {
		t.Fatal("NewClients() cleared the caller-owned transport proxy")
	}
	callerProxy, err := transport.Proxy(&http.Request{URL: &url.URL{Scheme: "http"}})
	if err != nil {
		t.Fatalf("caller-owned transport proxy error = %v", err)
	}
	if callerProxy == nil || callerProxy.String() != proxy.URL {
		t.Errorf("caller-owned transport proxy = %v, want %s", callerProxy, proxy.URL)
	}

	proxyRequests.Store(0)
	httpsClients, err := NewClients(httpClient, "https://198.51.100.1", "")
	if err != nil {
		t.Fatalf("NewClients() HTTPS error = %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancel()
	_, _ = httpsClients.Auth.GetCurrentUser(ctx, connect.NewRequest(&apiv1.GetCurrentUserRequest{}))
	if got := proxyRequests.Load(); got != 1 {
		t.Errorf("HTTPS proxy request count = %d, want 1", got)
	}
}

type opaqueRoundTripper struct {
	http.RoundTripper
}

func TestNewClientsRejectOpaqueRoundTripperThatMayRetainHTTP2(t *testing.T) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = true
	opaque := &opaqueRoundTripper{RoundTripper: transport}
	httpClient := &http.Client{Transport: opaque}

	if _, err := NewClients(httpClient, "https://nama.example.test", ""); err == nil {
		t.Fatal("NewClients() error = nil, want opaque transport rejection")
	}
	if httpClient.Transport != opaque {
		t.Error("NewClients() replaced the caller-owned opaque transport")
	}
	if !transport.ForceAttemptHTTP2 {
		t.Error("NewClients() changed the caller-owned transport HTTP/2 setting")
	}
}
