package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

const testBearer = "stored-session-bearer"

type recordingService struct {
	apiv1.UnimplementedSetupServiceHandler
	apiv1.UnimplementedAuthServiceHandler

	mu      sync.Mutex
	headers map[string]http.Header
}

func (service *recordingService) record(procedure string, header http.Header) {
	service.mu.Lock()
	defer service.mu.Unlock()
	service.headers[procedure] = header.Clone()
}

func (service *recordingService) GetStatus(_ context.Context, request *connect.Request[apiv1.GetStatusRequest]) (*connect.Response[apiv1.GetStatusResponse], error) {
	service.record(apiv1.SetupServiceGetStatusProcedure, request.Header())
	return connect.NewResponse(&apiv1.GetStatusResponse{}), nil
}

func (service *recordingService) CreateAdministrator(_ context.Context, request *connect.Request[apiv1.CreateAdministratorRequest]) (*connect.Response[apiv1.CreateAdministratorResponse], error) {
	service.record(apiv1.SetupServiceCreateAdministratorProcedure, request.Header())
	return connect.NewResponse(&apiv1.CreateAdministratorResponse{}), nil
}

func (service *recordingService) SignIn(_ context.Context, request *connect.Request[apiv1.SignInRequest]) (*connect.Response[apiv1.SignInResponse], error) {
	service.record(apiv1.AuthServiceSignInProcedure, request.Header())
	return connect.NewResponse(&apiv1.SignInResponse{}), nil
}

func (service *recordingService) GetCurrentUser(_ context.Context, request *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	service.record(apiv1.AuthServiceGetCurrentUserProcedure, request.Header())
	return connect.NewResponse(&apiv1.GetCurrentUserResponse{}), nil
}

func (service *recordingService) SignOut(_ context.Context, request *connect.Request[apiv1.SignOutRequest]) (*connect.Response[apiv1.SignOutResponse], error) {
	service.record(apiv1.AuthServiceSignOutProcedure, request.Header())
	return connect.NewResponse(&apiv1.SignOutResponse{}), nil
}

func newTestServer(t *testing.T) (*httptest.Server, *recordingService) {
	t.Helper()
	service := &recordingService{headers: make(map[string]http.Header)}
	mux := http.NewServeMux()
	setupPath, setupHandler := apiv1.NewSetupServiceHandler(service)
	authPath, authHandler := apiv1.NewAuthServiceHandler(service)
	mux.Handle(setupPath, setupHandler)
	mux.Handle(authPath, authHandler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, service
}

func TestNewClientsSendMetadataAndAttachBearerOnlyToProtectedMethods(t *testing.T) {
	server, service := newTestServer(t)
	clients, err := NewClients(server.Client(), server.URL, testBearer)
	if err != nil {
		t.Fatalf("NewClients() error = %v", err)
	}

	calls := []struct {
		procedure         string
		wantAuthorization string
		call              func(context.Context) error
	}{
		{apiv1.SetupServiceGetStatusProcedure, "", func(ctx context.Context) error {
			_, err := clients.Setup.GetStatus(ctx, connect.NewRequest(&apiv1.GetStatusRequest{}))
			return err
		}},
		{apiv1.SetupServiceCreateAdministratorProcedure, "", func(ctx context.Context) error {
			_, err := clients.Setup.CreateAdministrator(ctx, connect.NewRequest(&apiv1.CreateAdministratorRequest{}))
			return err
		}},
		{apiv1.AuthServiceSignInProcedure, "", func(ctx context.Context) error {
			_, err := clients.Auth.SignIn(ctx, connect.NewRequest(&apiv1.SignInRequest{}))
			return err
		}},
		{apiv1.AuthServiceGetCurrentUserProcedure, "Bearer " + testBearer, func(ctx context.Context) error {
			_, err := clients.Auth.GetCurrentUser(ctx, connect.NewRequest(&apiv1.GetCurrentUserRequest{}))
			return err
		}},
		{apiv1.AuthServiceSignOutProcedure, "Bearer " + testBearer, func(ctx context.Context) error {
			_, err := clients.Auth.SignOut(ctx, connect.NewRequest(&apiv1.SignOutRequest{}))
			return err
		}},
	}

	for _, test := range calls {
		if err := test.call(t.Context()); err != nil {
			t.Fatalf("%s() error = %v", test.procedure, err)
		}
	}
	for _, test := range calls {
		service.mu.Lock()
		header := service.headers[test.procedure]
		service.mu.Unlock()
		if header == nil {
			t.Errorf("server did not receive %s", test.procedure)
			continue
		}
		if got := header.Get("nama-client-name"); got != "nama-cli" {
			t.Errorf("%s nama-client-name = %q, want nama-cli", test.procedure, got)
		}
		if got := header.Get("nama-client-platform"); got != "go" {
			t.Errorf("%s nama-client-platform = %q, want go", test.procedure, got)
		}
		if got := header.Get("nama-client-version"); got != "0.0.0-dev" {
			t.Errorf("%s nama-client-version = %q, want 0.0.0-dev", test.procedure, got)
		}
		if got := header.Get("Authorization"); got != test.wantAuthorization {
			t.Errorf("%s Authorization = %q, want %q", test.procedure, got, test.wantAuthorization)
		}
	}
}

func TestClientInterceptorBoundsEveryInvocationToThirtySeconds(t *testing.T) {
	var remaining []time.Duration
	next := func(ctx context.Context, _ connect.AnyRequest) (connect.AnyResponse, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			remaining = append(remaining, 0)
		} else {
			remaining = append(remaining, time.Until(deadline))
		}
		return connect.NewResponse(&apiv1.GetStatusResponse{}), nil
	}
	call := clientInterceptor("")(next)

	for range 5 {
		if _, err := call(t.Context(), connect.NewRequest(&apiv1.GetStatusRequest{})); err != nil {
			t.Fatalf("intercepted call error = %v", err)
		}
	}
	if len(remaining) != 5 {
		t.Fatalf("captured %d deadlines, want 5", len(remaining))
	}
	for _, duration := range remaining {
		if duration < 29*time.Second || duration > 30*time.Second {
			t.Errorf("request deadline leaves %s, want at most 30 seconds", duration)
		}
	}
}

func TestNewClientsRejectUnsafeBaseURLs(t *testing.T) {
	for _, baseURL := range []string{
		"nama.example.test",
		"ftp://nama.example.test",
		"http://nama.example.test",
		"https://operator:password@nama.example.test",
		"https://nama.example.test/?next=/setup",
		"https://nama.example.test/#setup",
	} {
		t.Run(baseURL, func(t *testing.T) {
			if _, err := NewClients(http.DefaultClient, baseURL, ""); err == nil {
				t.Fatalf("NewClients(%q) error = nil, want unsafe URL rejection", baseURL)
			}
		})
	}
}

func TestNewClientsPreserveReverseProxyPath(t *testing.T) {
	service := &recordingService{headers: make(map[string]http.Header)}
	_, handler := apiv1.NewSetupServiceHandler(service)
	mux := http.NewServeMux()
	mux.Handle("/proxy/", http.StripPrefix("/proxy", handler))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	clients, err := NewClients(server.Client(), server.URL+"/proxy/", "")
	if err != nil {
		t.Fatalf("NewClients() error = %v", err)
	}
	if _, err := clients.Setup.GetStatus(t.Context(), connect.NewRequest(&apiv1.GetStatusRequest{})); err != nil {
		t.Fatalf("GetStatus() error = %v", err)
	}
}
