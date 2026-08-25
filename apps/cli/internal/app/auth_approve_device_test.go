package app

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

const approvalUserCode = "ABCD-EFGH"

type approvalAuthServiceFake struct {
	apiv1.UnimplementedAuthServiceHandler
	calls   int
	request *connect.Request[apiv1.ApproveDeviceAuthorizationRequest]
}

func (f *approvalAuthServiceFake) ApproveDeviceAuthorization(_ context.Context, request *connect.Request[apiv1.ApproveDeviceAuthorizationRequest]) (*connect.Response[apiv1.ApproveDeviceAuthorizationResponse], error) {
	f.calls++
	f.request = request
	return connect.NewResponse(&apiv1.ApproveDeviceAuthorizationResponse{}), nil
}

func TestApproveDeviceAuthorizationUsesSelectedSessionBearer(t *testing.T) {
	credential := auth.Credential{
		Token:     oldBearer,
		ExpiresAt: time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC),
		Server:    loginServer,
	}
	store := &statusCredentialStoreFake{credential: credential, exists: true}
	client := &approvalAuthServiceFake{}

	result, err := ApproveDeviceAuthorization(t.Context(), ApproveDeviceAuthorizationInput{
		Session: SelectedSession{
			Profile:       loginProfile,
			ProfileServer: loginServer,
			Server:        loginServer,
		},
		UserCode: approvalUserCode,
	}, client, store)

	if err != nil {
		t.Fatalf("ApproveDeviceAuthorization() error = %v", err)
	}
	if !result.Approved || result.Profile != loginProfile || result.Server != loginServer {
		t.Fatalf("ApproveDeviceAuthorization() result = %#v", result)
	}
	if client.calls != 1 || client.request == nil {
		t.Fatalf("ApproveDeviceAuthorization calls = %d, request = %#v", client.calls, client.request)
	}
	if got := client.request.Header().Get("Authorization"); got != "Bearer "+oldBearer {
		t.Errorf("approval authorization = %q, want selected bearer", got)
	}
	if got := client.request.Msg.GetUserCode(); got != approvalUserCode {
		t.Errorf("approval user code = %q, want %q", got, approvalUserCode)
	}
}

type revocationAuthServiceFake struct {
	apiv1.UnimplementedAuthServiceHandler
	calls   int
	request *connect.Request[apiv1.RevokeAppleClientRefreshTokensRequest]
}

func (f *revocationAuthServiceFake) RevokeAppleClientRefreshTokens(_ context.Context, request *connect.Request[apiv1.RevokeAppleClientRefreshTokensRequest]) (*connect.Response[apiv1.RevokeAppleClientRefreshTokensResponse], error) {
	f.calls++
	f.request = request
	return connect.NewResponse(&apiv1.RevokeAppleClientRefreshTokensResponse{}), nil
}

func TestRevokeAppleClientRefreshTokensUsesSelectedAdministratorSession(t *testing.T) {
	credential := auth.Credential{
		Token:     oldBearer,
		ExpiresAt: time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC),
		Server:    loginServer,
	}
	store := &statusCredentialStoreFake{credential: credential, exists: true}
	client := &revocationAuthServiceFake{}

	result, err := RevokeAppleClientRefreshTokens(t.Context(), RevokeAppleClientRefreshTokensInput{
		Session: SelectedSession{
			Profile:       loginProfile,
			ProfileServer: loginServer,
			Server:        loginServer,
		},
	}, client, store)

	if err != nil {
		t.Fatalf("RevokeAppleClientRefreshTokens() error = %v", err)
	}
	if !result.Revoked || result.Profile != loginProfile || result.Server != loginServer {
		t.Fatalf("RevokeAppleClientRefreshTokens() result = %#v", result)
	}
	if client.calls != 1 || client.request == nil {
		t.Fatalf("RevokeAppleClientRefreshTokens calls = %d, request = %#v", client.calls, client.request)
	}
	if got := client.request.Header().Get("Authorization"); got != "Bearer "+oldBearer {
		t.Errorf("revocation authorization = %q, want selected bearer", got)
	}
}
