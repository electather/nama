package app

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

// ListProviderTypesInput contains the authenticated profile and page request.
type ListProviderTypesInput struct {
	Profile   string
	Server    string
	PageSize  uint32
	PageToken string
}

// ProviderType is the provider-neutral CLI projection of one installed provider type.
type ProviderType struct {
	ID                   string         `json:"id"`
	DisplayName          string         `json:"display_name"`
	Description          string         `json:"description"`
	Capabilities         []string       `json:"capabilities"`
	ConfigurationSchema  map[string]any `json:"configuration_schema"`
	SchemaProfileVersion uint32         `json:"schema_profile_version"`
	SchemaRevision       string         `json:"schema_revision"`
}

// ListProviderTypesResult is one bounded provider-type page.
type ListProviderTypesResult struct {
	ProviderTypes []ProviderType `json:"provider_types"`
	NextPageToken string         `json:"next_page_token,omitempty"`
}

// ListProviderTypes reads one authenticated provider-type page.
func ListProviderTypes(
	ctx context.Context,
	input ListProviderTypesInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (ListProviderTypesResult, error) {
	credential, found, err := credentials.Get(ctx, input.Profile)
	if err != nil {
		return ListProviderTypesResult{}, credentialReadFailure(err)
	}
	if !found || credential.Token == "" {
		return ListProviderTypesResult{}, clierror.New(clierror.CodeUnauthenticated, errors.New("administrator credential is required"))
	}
	if !credential.Injected && credential.Server != input.Server {
		return ListProviderTypesResult{}, clierror.New(clierror.CodeUnauthenticated, errors.New("credential target does not match selected server"))
	}

	request := connect.NewRequest(&apiv1.ListProviderTypesRequest{
		PageSize:  input.PageSize,
		PageToken: input.PageToken,
	})
	request.Header().Set("Authorization", "Bearer "+credential.Token)
	response, err := client.ListProviderTypes(ctx, request)
	if err != nil {
		return ListProviderTypesResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return ListProviderTypesResult{}, clierror.Unexpected(errors.New("invalid provider-type response"))
	}

	providerTypes := make([]ProviderType, 0, len(response.Msg.GetProviderTypes()))
	for _, providerType := range response.Msg.GetProviderTypes() {
		if providerType == nil || providerType.GetId() == "" || providerType.GetDisplayName() == "" || providerType.GetConfigurationSchema() == nil || providerType.GetSchemaProfileVersion() == 0 || providerType.GetSchemaRevision() == "" {
			return ListProviderTypesResult{}, clierror.Unexpected(errors.New("invalid provider type"))
		}
		capabilities := make([]string, 0, len(providerType.GetCapabilities()))
		for _, capability := range providerType.GetCapabilities() {
			if name, known := providerCapabilityName(capability); known {
				capabilities = append(capabilities, name)
			}
		}
		providerTypes = append(providerTypes, ProviderType{
			ID:                   providerType.GetId(),
			DisplayName:          providerType.GetDisplayName(),
			Description:          providerType.GetDescription(),
			Capabilities:         capabilities,
			ConfigurationSchema:  providerType.GetConfigurationSchema().AsMap(),
			SchemaProfileVersion: providerType.GetSchemaProfileVersion(),
			SchemaRevision:       providerType.GetSchemaRevision(),
		})
	}
	return ListProviderTypesResult{
		ProviderTypes: providerTypes,
		NextPageToken: response.Msg.GetNextPageToken(),
	}, nil
}

func providerCapabilityName(capability apiv1.ProviderCapability) (string, bool) {
	switch capability {
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_LIBRARY_READ:
		return "library_read", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_ARTWORK_RESOLVE:
		return "artwork_resolve", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_PLAYBACK_PLAN:
		return "playback_plan", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_PLAYBACK_OPEN:
		return "playback_open", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_PLAYBACK_REPORT:
		return "playback_report", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_PLAYBACK_REPORTS_USER_STATE:
		return "playback_reports_user_state", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_WATCH_STATE_READ:
		return "watch_state_read", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_WATCHED_WRITE:
		return "watched_write", true
	case apiv1.ProviderCapability_PROVIDER_CAPABILITY_PROGRESS_WRITE:
		return "progress_write", true
	default:
		return "", false
	}
}
