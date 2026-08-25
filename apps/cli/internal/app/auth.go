package app

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

var errInjectedCredential = errors.New("cannot mint a credential while NAMA_TOKEN is set")

// LoginInput contains the resolved sign-in values for a selected profile.
type LoginInput struct {
	Profile  string
	Server   string
	Email    string
	Password string
}

// LoginResult is the public result of a successful sign-in.
type LoginResult struct {
	Profile             string               `json:"profile"`
	Server              string               `json:"server"`
	SignedIn            bool                 `json:"signed_in"`
	Administrator       *apiv1.Administrator `json:"administrator"`
	CredentialExpiresAt time.Time            `json:"credential_expires_at"`
}

// ApproveDeviceAuthorizationInput contains the selected session and displayed user code.
type ApproveDeviceAuthorizationInput struct {
	Session  SelectedSession
	UserCode string
}

// ApproveDeviceAuthorizationResult reports a completed explicit approval.
type ApproveDeviceAuthorizationResult struct {
	Profile  string `json:"profile,omitempty"`
	Server   string `json:"server"`
	Approved bool   `json:"approved"`
}

// ApproveDeviceAuthorization approves one Better Auth device authorization with the selected session.
func ApproveDeviceAuthorization(ctx context.Context, input ApproveDeviceAuthorizationInput, client apiv1.AuthServiceClient, credentials auth.CredentialStore) (ApproveDeviceAuthorizationResult, error) {
	if input.UserCode == "" {
		return ApproveDeviceAuthorizationResult{}, clierror.InvalidArgument(errors.New("user code is required"))
	}
	credential, err := selectedSessionCredential(ctx, input.Session, credentials)
	if err != nil {
		return ApproveDeviceAuthorizationResult{}, err
	}

	request := connect.NewRequest(&apiv1.ApproveDeviceAuthorizationRequest{UserCode: input.UserCode})
	request.Header().Set("Authorization", "Bearer "+credential.Token)
	if _, err := client.ApproveDeviceAuthorization(ctx, request); err != nil {
		return ApproveDeviceAuthorizationResult{}, clierror.Translate(err)
	}
	return ApproveDeviceAuthorizationResult{
		Profile:  input.Session.Profile,
		Server:   input.Session.Server,
		Approved: true,
	}, nil
}

// RevokeAppleClientRefreshTokensInput contains the selected Administrator session.
type RevokeAppleClientRefreshTokensInput struct {
	Session SelectedSession
}

// RevokeAppleClientRefreshTokensResult reports broad fixed-client revocation.
type RevokeAppleClientRefreshTokensResult struct {
	Profile string `json:"profile,omitempty"`
	Server  string `json:"server"`
	Revoked bool   `json:"revoked"`
}

// RevokeAppleClientRefreshTokens revokes every refresh-token family for the Apple public client.
func RevokeAppleClientRefreshTokens(ctx context.Context, input RevokeAppleClientRefreshTokensInput, client apiv1.AuthServiceClient, credentials auth.CredentialStore) (RevokeAppleClientRefreshTokensResult, error) {
	credential, err := selectedSessionCredential(ctx, input.Session, credentials)
	if err != nil {
		return RevokeAppleClientRefreshTokensResult{}, err
	}
	request := connect.NewRequest(&apiv1.RevokeAppleClientRefreshTokensRequest{})
	request.Header().Set("Authorization", "Bearer "+credential.Token)
	if _, err := client.RevokeAppleClientRefreshTokens(ctx, request); err != nil {
		return RevokeAppleClientRefreshTokensResult{}, clierror.Translate(err)
	}
	return RevokeAppleClientRefreshTokensResult{
		Profile: input.Session.Profile,
		Server:  input.Session.Server,
		Revoked: true,
	}, nil
}

func selectedSessionCredential(ctx context.Context, session SelectedSession, credentials auth.CredentialStore) (auth.Credential, error) {
	credential, found, err := credentials.Get(ctx, session.Profile)
	if err != nil {
		return auth.Credential{}, credentialReadFailure(err)
	}
	if !found || credential.Token == "" {
		return auth.Credential{}, clierror.New(clierror.CodeUnauthenticated, errors.New("authentication is required"))
	}
	if !credential.Injected && (session.Profile == "" || session.ProfileServer != session.Server || credential.Server != session.Server) {
		return auth.Credential{}, clierror.New(clierror.CodeUnauthenticated, errors.New("selected credential does not belong to the Nama endpoint"))
	}
	return credential, nil
}

// Login signs in once and replaces the selected profile's stored credential.
func Login(ctx context.Context, input LoginInput, client apiv1.AuthServiceClient, credentials auth.CredentialStore) (LoginResult, error) {
	previous, previousExists, err := credentials.Get(ctx, input.Profile)
	if err != nil {
		return LoginResult{}, credentialReadFailure(err)
	}
	if previous.Injected {
		return LoginResult{}, clierror.InvalidArgument(errInjectedCredential)
	}

	response, err := client.SignIn(ctx, connect.NewRequest(&apiv1.SignInRequest{
		Email:    input.Email,
		Password: input.Password,
	}))
	if err != nil {
		return LoginResult{}, clierror.Translate(err)
	}

	administrator, credential, err := signInValues(response)
	if err != nil {
		if credential.Token != "" {
			if revokeErr := revokeCredential(ctx, client, credential); revokeErr != nil {
				return LoginResult{}, revokeErr
			}
		}
		return LoginResult{}, err
	}
	credential.Server = input.Server

	if err := credentials.Put(ctx, input.Profile, credential); err != nil {
		storeErr := err
		if restoreErr := restoreCredential(ctx, credentials, input.Profile, previous, previousExists); restoreErr != nil {
			storeErr = restoreErr
		}
		return LoginResult{}, loginStorageFailure(ctx, client, credential, storeErr)
	}

	return LoginResult{
		Profile:             input.Profile,
		Server:              input.Server,
		SignedIn:            true,
		Administrator:       administrator,
		CredentialExpiresAt: credential.ExpiresAt,
	}, nil
}

func credentialReadFailure(err error) *clierror.Error {
	if errors.Is(err, auth.ErrCredentialCleanupFailed) {
		return clierror.CredentialCleanupFailed(err)
	}
	return clierror.CredentialStoreUnavailable(err)
}

// SelectedSession contains the resolved target and optional selected profile.
type SelectedSession struct {
	Profile       string
	ProfileServer string
	Server        string
}

type injectedCredentialStore interface {
	Injected() (auth.Credential, bool)
}

// StatusResult is the public authentication state for a target.
type StatusResult struct {
	Profile             string               `json:"profile,omitempty"`
	Server              string               `json:"server"`
	SignedIn            bool                 `json:"signed_in"`
	Administrator       *apiv1.Administrator `json:"administrator,omitempty"`
	CredentialExpiresAt *time.Time           `json:"credential_expires_at,omitempty"`
}

// Status reports the selected credential's current authentication state.
func Status(ctx context.Context, input SelectedSession, client apiv1.AuthServiceClient, credentials auth.CredentialStore) (StatusResult, error) {
	result := StatusResult{Profile: input.Profile, Server: input.Server}
	eligibleStoredCredential := input.Profile != "" && input.Server == input.ProfileServer

	var credential auth.Credential
	var found bool
	var err error
	if store, ok := credentials.(injectedCredentialStore); ok {
		credential, found = store.Injected()
		if !found && !eligibleStoredCredential {
			return result, nil
		}
		if !found {
			credential, found, err = credentials.Get(ctx, input.Profile)
			if err != nil {
				return StatusResult{}, credentialReadFailure(err)
			}
		}
	} else {
		credential, found, err = credentials.Get(ctx, input.Profile)
		if err != nil {
			if !eligibleStoredCredential {
				return result, nil
			}
			return StatusResult{}, credentialReadFailure(err)
		}
	}
	if !found || (!credential.Injected && (!eligibleStoredCredential || credential.Server != input.Server)) {
		return result, nil
	}
	if credential.Token == "" {
		return StatusResult{}, clierror.CredentialStoreUnavailable(errors.New("invalid credential record"))
	}

	request := connect.NewRequest(&apiv1.GetCurrentUserRequest{})
	request.Header().Set("Authorization", "Bearer "+credential.Token)
	response, err := client.GetCurrentUser(ctx, request)
	if err != nil {
		translated := clierror.Translate(err)
		if !credentialRejected(translated) {
			return StatusResult{}, translated
		}
		if !credential.Injected {
			if err := credentials.Delete(ctx, input.Profile); err != nil {
				return StatusResult{}, clierror.CredentialCleanupFailed(err)
			}
		}
		return StatusResult{}, translated
	}
	if response == nil || response.Msg == nil || !validAdministrator(response.Msg.GetAdministrator()) {
		return StatusResult{}, clierror.Unexpected(errors.New("invalid current-user response"))
	}

	result.SignedIn = true
	result.Administrator = response.Msg.GetAdministrator()
	if !credential.Injected {
		result.CredentialExpiresAt = new(credential.ExpiresAt.UTC())
	}
	return result, nil
}

func signInValues(response *connect.Response[apiv1.SignInResponse]) (*apiv1.Administrator, auth.Credential, error) {
	if response == nil || response.Msg == nil {
		return nil, auth.Credential{}, clierror.Unexpected(errors.New("invalid sign-in response"))
	}

	signInCredential := response.Msg.GetCredential()
	credential := auth.Credential{}
	if signInCredential != nil {
		credential.Token = signInCredential.GetToken()
	}
	if !validAdministrator(response.Msg.GetAdministrator()) || signInCredential == nil {
		return nil, credential, clierror.Unexpected(errors.New("invalid sign-in response"))
	}

	expiresAt := signInCredential.GetExpiresAt()
	if credential.Token == "" || expiresAt == nil || expiresAt.CheckValid() != nil {
		return nil, credential, clierror.Unexpected(errors.New("invalid sign-in credential"))
	}
	credential.ExpiresAt = expiresAt.AsTime().UTC()
	return response.Msg.GetAdministrator(), credential, nil
}

func restoreCredential(ctx context.Context, credentials auth.CredentialStore, profile string, previous auth.Credential, previousExists bool) error {
	if previousExists {
		return credentials.Put(ctx, profile, previous)
	}
	return credentials.Delete(ctx, profile)
}

func loginStorageFailure(ctx context.Context, client apiv1.AuthServiceClient, credential auth.Credential, storeErr error) error {
	if err := revokeCredential(ctx, client, credential); err != nil {
		return err
	}
	return clierror.CredentialStoreUnavailable(storeErr)
}

func revokeCredential(ctx context.Context, client apiv1.AuthServiceClient, credential auth.Credential) error {
	request := connect.NewRequest(&apiv1.SignOutRequest{})
	request.Header().Set("Authorization", "Bearer "+credential.Token)
	if _, err := client.SignOut(ctx, request); err != nil {
		return clierror.New(clierror.CodeSessionRevocationUnconfirmed, err)
	}
	return nil
}

func credentialRejected(err *clierror.Error) bool {
	switch err.Code {
	case clierror.CodeAuthenticationFailed, clierror.CodeCredentialInvalid, clierror.CodeUnauthenticated:
		return true
	default:
		return false
	}
}
