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

const setupRecoveryTimeout = 30 * time.Second

var (
	errMissingSetupStatusResponse = errors.New("missing setup status response")
	errMalformedCreateResponse    = errors.New("malformed administrator creation response")
	errMissingSetupDependency     = errors.New("missing setup dependency")
	errServerAlreadyInitialized   = errors.New("server already initialized")
)

// SetupInput contains resolved setup values and secrets.
type SetupInput struct {
	Profile        string
	Server         string
	BootstrapToken string
	DisplayName    string
	Email          string
	Password       string
}

// SetupResult reports a completed setup without exposing its credential.
type SetupResult struct {
	Profile             string               `json:"profile"`
	Server              string               `json:"server"`
	Initialized         bool                 `json:"initialized"`
	SignedIn            bool                 `json:"signed_in"`
	Administrator       *apiv1.Administrator `json:"administrator"`
	CredentialExpiresAt time.Time            `json:"credential_expires_at"`
}

// Setup initializes an administrator, signs it in, and stores its credential.
func Setup(ctx context.Context, input SetupInput, setupClient apiv1.SetupServiceClient, authClient apiv1.AuthServiceClient, credentials auth.CredentialStore) (SetupResult, error) {
	if setupClient == nil || authClient == nil || credentials == nil {
		return SetupResult{}, clierror.Unexpected(errMissingSetupDependency)
	}

	previous, previousExists, err := credentials.Get(ctx, input.Profile)
	if err != nil {
		return SetupResult{}, credentialReadFailure(err)
	}
	if previous.Injected {
		return SetupResult{}, clierror.InvalidArgument(errInjectedCredential)
	}

	status, err := setupClient.GetStatus(ctx, connect.NewRequest(&apiv1.GetStatusRequest{}))
	if err != nil {
		return SetupResult{}, clierror.Translate(err)
	}
	if !validSetupStatusResponse(status) {
		return SetupResult{}, clierror.Unexpected(errMissingSetupStatusResponse)
	}
	if status.Msg.GetInitialized() {
		return SetupResult{}, clierror.New(clierror.CodeAlreadyInitialized, errServerAlreadyInitialized)
	}

	created, err := setupClient.CreateAdministrator(ctx, connect.NewRequest(&apiv1.CreateAdministratorRequest{
		BootstrapToken: input.BootstrapToken,
		DisplayName:    input.DisplayName,
		Email:          input.Email,
		Password:       input.Password,
	}))
	if err != nil {
		if !ambiguousSetupCreate(err) {
			return SetupResult{}, clierror.Translate(err)
		}
		if recoveryErr := recoverSetupCreation(ctx, setupClient, err); recoveryErr != nil {
			return SetupResult{}, recoveryErr
		}
		settlementContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), setupRecoveryTimeout)
		defer cancel()
		ctx = settlementContext
	} else if !validCreatedAdministratorResponse(created) {
		return SetupResult{}, clierror.Unexpected(errMalformedCreateResponse)
	}

	signIn, err := authClient.SignIn(ctx, connect.NewRequest(&apiv1.SignInRequest{
		Email:    input.Email,
		Password: input.Password,
	}))
	if err != nil {
		return SetupResult{}, clierror.Translate(err)
	}
	administrator, credential, err := signInValues(signIn)
	if err != nil {
		if credential.Token != "" {
			if revokeErr := revokeCredential(ctx, authClient, credential); revokeErr != nil {
				return SetupResult{}, revokeErr
			}
		}
		return SetupResult{}, err
	}
	credential.Server = input.Server
	if err := credentials.Put(ctx, input.Profile, credential); err != nil {
		storeErr := err
		if restoreErr := restoreCredential(ctx, credentials, input.Profile, previous, previousExists); restoreErr != nil {
			storeErr = restoreErr
		}
		if revokeErr := revokeCredential(ctx, authClient, credential); revokeErr != nil {
			return SetupResult{}, revokeErr
		}
		return SetupResult{}, clierror.CredentialStoreUnavailable(storeErr)
	}

	return SetupResult{
		Profile:             input.Profile,
		Server:              input.Server,
		Initialized:         true,
		SignedIn:            true,
		Administrator:       administrator,
		CredentialExpiresAt: credential.ExpiresAt,
	}, nil
}

func recoverSetupCreation(ctx context.Context, setupClient apiv1.SetupServiceClient, createErr error) error {
	recoveryContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), setupRecoveryTimeout)
	defer cancel()

	status, err := setupClient.GetStatus(recoveryContext, connect.NewRequest(&apiv1.GetStatusRequest{}))
	if err != nil {
		return clierror.New(clierror.CodeSetupUnavailable, err)
	}
	if !validSetupStatusResponse(status) {
		return clierror.Unexpected(errMissingSetupStatusResponse)
	}
	if !status.Msg.GetInitialized() {
		return clierror.Translate(createErr)
	}
	return nil
}

func ambiguousSetupCreate(err error) bool {
	return !connect.IsWireError(err)
}

func validSetupStatusResponse(response *connect.Response[apiv1.GetStatusResponse]) bool {
	return response != nil && response.Msg != nil
}

func validCreatedAdministratorResponse(response *connect.Response[apiv1.CreateAdministratorResponse]) bool {
	return response != nil && validAdministrator(response.Msg.GetAdministrator())
}

func validAdministrator(administrator *apiv1.Administrator) bool {
	return administrator != nil && administrator.GetId() != "" && administrator.GetDisplayName() != "" && administrator.GetEmail() != ""
}
