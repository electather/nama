package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"slices"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/protobuf/types/known/structpb"
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

// ConfiguredSecret reports only whether one write-only configuration key exists.
type ConfiguredSecret struct {
	Key        string `json:"key"`
	Configured bool   `json:"configured"`
}

// ProviderInstance is the provider-neutral, credential-free CLI projection.
type ProviderInstance struct {
	ID                string             `json:"id"`
	ProviderTypeID    string             `json:"provider_type_id"`
	DisplayName       string             `json:"display_name"`
	Enabled           bool               `json:"enabled"`
	SyncPriority      uint32             `json:"sync_priority"`
	Status            string             `json:"status"`
	Configuration     map[string]any     `json:"configuration"`
	ConfiguredSecrets []ConfiguredSecret `json:"configured_secrets"`
	Revision          string             `json:"revision"`
	CreatedAt         time.Time          `json:"created_at"`
	UpdatedAt         time.Time          `json:"updated_at"`
}

// ListProviderInstancesInput contains the authenticated profile and page request.
type ListProviderInstancesInput struct {
	Profile   string
	Server    string
	PageSize  uint32
	PageToken string
}

// ListProviderInstancesResult is one bounded provider-instance page.
type ListProviderInstancesResult struct {
	ProviderInstances []ProviderInstance `json:"provider_instances"`
	NextPageToken     string             `json:"next_page_token,omitempty"`
}

// GetProviderInstanceInput selects one provider instance through an authenticated profile.
type GetProviderInstanceInput struct {
	Profile            string
	ProviderInstanceID string
	Server             string
}

// GetProviderInstanceResult contains one safe provider instance.
type GetProviderInstanceResult struct {
	ProviderInstance ProviderInstance `json:"provider_instance"`
}

// CreateProviderInstanceInput contains one complete schema-driven provider configuration.
type CreateProviderInstanceInput struct {
	Profile        string
	Server         string
	OperationID    string
	ProviderTypeID string
	DisplayName    string
	Configuration  map[string]any
	Enabled        bool
	SyncPriority   *uint32
}

// CreateProviderInstanceResult includes the retry key used for this mutation.
type CreateProviderInstanceResult struct {
	OperationID      string           `json:"operation_id"`
	ProviderInstance ProviderInstance `json:"provider_instance"`
}

// UpdateProviderInstanceInput contains one optimistic provider-instance patch.
type UpdateProviderInstanceInput struct {
	Profile                  string
	Server                   string
	OperationID              string
	ProviderInstanceID       string
	ExpectedRevision         string
	ConfigurationPatch       map[string]any
	ClearConfigurationFields []string
	DisplayName              *string
	Enabled                  *bool
	SyncPriority             *uint32
}

// UpdateProviderInstanceResult includes the retry key used for this mutation.
type UpdateProviderInstanceResult struct {
	OperationID      string           `json:"operation_id"`
	ProviderInstance ProviderInstance `json:"provider_instance"`
}

// DeleteProviderInstanceInput contains one optimistic provider-instance deletion.
type DeleteProviderInstanceInput struct {
	Profile            string
	Server             string
	OperationID        string
	ProviderInstanceID string
	ExpectedRevision   string
}

// DeleteProviderInstanceResult includes the retry key used for this mutation.
type DeleteProviderInstanceResult struct {
	OperationID string `json:"operation_id"`
}

// ProviderConnectionTest is one safe provider connection observation.
type ProviderConnectionTest struct {
	Status        string   `json:"status"`
	Summary       string   `json:"summary"`
	RemoteName    string   `json:"remote_name,omitempty"`
	RemoteVersion string   `json:"remote_version,omitempty"`
	Capabilities  []string `json:"capabilities"`
}

// TestProviderConfigurationInput contains one complete candidate provider configuration.
type TestProviderConfigurationInput struct {
	Profile        string
	Server         string
	ProviderTypeID string
	Configuration  map[string]any
}

// TestProviderConfigurationResult contains one completed candidate connection test.
type TestProviderConfigurationResult struct {
	ConnectionTest ProviderConnectionTest `json:"connection_test"`
}

// TestProviderInstanceInput selects one stored provider connection through an authenticated profile.
type TestProviderInstanceInput struct {
	Profile            string
	Server             string
	ProviderInstanceID string
}

// TestProviderInstanceResult contains one completed stored-instance connection test.
type TestProviderInstanceResult struct {
	ConnectionTest ProviderConnectionTest `json:"connection_test"`
}

func providerCredential(
	ctx context.Context,
	profile string,
	server string,
	credentials auth.CredentialStore,
) (auth.Credential, error) {
	credential, found, err := credentials.Get(ctx, profile)
	if err != nil {
		return auth.Credential{}, credentialReadFailure(err)
	}
	if !found || credential.Token == "" {
		return auth.Credential{}, clierror.New(clierror.CodeUnauthenticated, errors.New("administrator credential is required"))
	}
	if !credential.Injected && credential.Server != server {
		return auth.Credential{}, clierror.New(clierror.CodeUnauthenticated, errors.New("credential target does not match selected server"))
	}
	return credential, nil
}

func attachProviderCredential[T any](request *connect.Request[T], credential auth.Credential) {
	request.Header().Set("Authorization", "Bearer "+credential.Token)
}

// ListProviderTypes reads one authenticated provider-type page.
func ListProviderTypes(
	ctx context.Context,
	input ListProviderTypesInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (ListProviderTypesResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return ListProviderTypesResult{}, err
	}
	request := connect.NewRequest(&apiv1.ListProviderTypesRequest{
		PageSize: input.PageSize, PageToken: input.PageToken,
	})
	attachProviderCredential(request, credential)
	response, err := client.ListProviderTypes(ctx, request)
	if err != nil {
		return ListProviderTypesResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return ListProviderTypesResult{}, clierror.Unexpected(errors.New("invalid provider-type response"))
	}

	providerTypes := make([]ProviderType, 0, len(response.Msg.GetProviderTypes()))
	for _, providerType := range response.Msg.GetProviderTypes() {
		if providerType == nil || providerType.GetConfigurationSchema() == nil {
			return ListProviderTypesResult{}, clierror.Unexpected(errors.New("invalid provider type"))
		}
		capabilities := make([]string, 0, len(providerType.GetCapabilities()))
		for _, capability := range providerType.GetCapabilities() {
			name, known := providerCapabilityName(capability)
			if known {
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

// ListProviderInstances reads one authenticated provider-instance page.
func ListProviderInstances(
	ctx context.Context,
	input ListProviderInstancesInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (ListProviderInstancesResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return ListProviderInstancesResult{}, err
	}
	request := connect.NewRequest(&apiv1.ListProviderInstancesRequest{
		PageSize: input.PageSize, PageToken: input.PageToken,
	})
	attachProviderCredential(request, credential)
	response, err := client.ListProviderInstances(ctx, request)
	if err != nil {
		return ListProviderInstancesResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return ListProviderInstancesResult{}, clierror.Unexpected(errors.New("invalid provider-instance response"))
	}
	instances := make([]ProviderInstance, 0, len(response.Msg.GetProviderInstances()))
	for _, value := range response.Msg.GetProviderInstances() {
		instance, mapErr := mapProviderInstance(value)
		if mapErr != nil {
			return ListProviderInstancesResult{}, mapErr
		}
		instances = append(instances, instance)
	}
	return ListProviderInstancesResult{
		ProviderInstances: instances,
		NextPageToken:     response.Msg.GetNextPageToken(),
	}, nil
}

// GetProviderInstance reads one authenticated provider instance.
func GetProviderInstance(
	ctx context.Context,
	input GetProviderInstanceInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (GetProviderInstanceResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return GetProviderInstanceResult{}, err
	}
	request := connect.NewRequest(&apiv1.GetProviderInstanceRequest{
		ProviderInstanceId: input.ProviderInstanceID,
	})
	attachProviderCredential(request, credential)
	response, err := client.GetProviderInstance(ctx, request)
	if err != nil {
		return GetProviderInstanceResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return GetProviderInstanceResult{}, clierror.Unexpected(errors.New("invalid provider-instance response"))
	}
	instance, err := mapProviderInstance(response.Msg.GetProviderInstance())
	if err != nil {
		return GetProviderInstanceResult{}, err
	}
	return GetProviderInstanceResult{ProviderInstance: instance}, nil
}

// TestProviderConfiguration checks one complete candidate configuration without persisting it.
func TestProviderConfiguration(
	ctx context.Context,
	input TestProviderConfigurationInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (TestProviderConfigurationResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return TestProviderConfigurationResult{}, err
	}
	configuration, err := structpb.NewStruct(input.Configuration)
	if err != nil {
		return TestProviderConfigurationResult{}, clierror.InvalidArgument(errors.New("configuration must be a JSON object"))
	}
	request := connect.NewRequest(&apiv1.TestProviderConfigurationRequest{
		ProviderTypeId: input.ProviderTypeID,
		Configuration:  configuration,
	})
	attachProviderCredential(request, credential)
	response, err := client.TestProviderConfiguration(ctx, request)
	if err != nil {
		return TestProviderConfigurationResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return TestProviderConfigurationResult{}, clierror.Unexpected(errors.New("invalid provider connection-test response"))
	}
	connectionTest, err := mapProviderConnectionTest(response.Msg.GetResult())
	if err != nil {
		return TestProviderConfigurationResult{}, err
	}
	return TestProviderConfigurationResult{ConnectionTest: connectionTest}, nil
}

// TestProviderInstance checks one stored provider instance's current durable revision.
func TestProviderInstance(
	ctx context.Context,
	input TestProviderInstanceInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (TestProviderInstanceResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return TestProviderInstanceResult{}, err
	}
	request := connect.NewRequest(&apiv1.TestProviderInstanceRequest{
		ProviderInstanceId: input.ProviderInstanceID,
	})
	attachProviderCredential(request, credential)
	response, err := client.TestProviderInstance(ctx, request)
	if err != nil {
		return TestProviderInstanceResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return TestProviderInstanceResult{}, clierror.Unexpected(errors.New("invalid provider connection-test response"))
	}
	connectionTest, err := mapProviderConnectionTest(response.Msg.GetResult())
	if err != nil {
		return TestProviderInstanceResult{}, err
	}
	return TestProviderInstanceResult{ConnectionTest: connectionTest}, nil
}

// CreateProviderInstance verifies and persists one provider instance.
func CreateProviderInstance(
	ctx context.Context,
	input CreateProviderInstanceInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (CreateProviderInstanceResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return CreateProviderInstanceResult{}, err
	}
	operationID := input.OperationID
	if operationID == "" {
		operationID, err = newOperationID()
		if err != nil {
			return CreateProviderInstanceResult{}, clierror.Unexpected(err)
		}
	}
	configuration, err := structpb.NewStruct(input.Configuration)
	if err != nil {
		return CreateProviderInstanceResult{}, clierror.InvalidArgument(errors.New("configuration must be a JSON object"))
	}
	message := &apiv1.CreateProviderInstanceRequest{
		OperationId:    operationID,
		ProviderTypeId: input.ProviderTypeID,
		DisplayName:    input.DisplayName,
		Configuration:  configuration,
		Enabled:        input.Enabled,
	}
	if input.SyncPriority != nil {
		message.SyncPriority = input.SyncPriority
	}
	request := connect.NewRequest(message)
	attachProviderCredential(request, credential)
	response, err := client.CreateProviderInstance(ctx, request)
	if err != nil {
		return CreateProviderInstanceResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return CreateProviderInstanceResult{}, clierror.Unexpected(errors.New("invalid provider-instance response"))
	}
	instance, err := mapProviderInstance(response.Msg.GetProviderInstance())
	if err != nil {
		return CreateProviderInstanceResult{}, err
	}
	return CreateProviderInstanceResult{OperationID: operationID, ProviderInstance: instance}, nil
}

// UpdateProviderInstance verifies and atomically persists one provider-instance patch.
func UpdateProviderInstance(
	ctx context.Context,
	input UpdateProviderInstanceInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (UpdateProviderInstanceResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return UpdateProviderInstanceResult{}, err
	}
	operationID := input.OperationID
	if operationID == "" {
		operationID, err = newOperationID()
		if err != nil {
			return UpdateProviderInstanceResult{}, clierror.Unexpected(err)
		}
	}
	configurationPatch, err := structpb.NewStruct(input.ConfigurationPatch)
	if err != nil {
		return UpdateProviderInstanceResult{}, clierror.InvalidArgument(errors.New("configuration patch must be a JSON object"))
	}
	message := &apiv1.UpdateProviderInstanceRequest{
		OperationId:              operationID,
		ProviderInstanceId:       input.ProviderInstanceID,
		ExpectedRevision:         input.ExpectedRevision,
		ConfigurationPatch:       configurationPatch,
		ClearConfigurationFields: slices.Clone(input.ClearConfigurationFields),
		DisplayName:              input.DisplayName,
		Enabled:                  input.Enabled,
		SyncPriority:             input.SyncPriority,
	}
	request := connect.NewRequest(message)
	attachProviderCredential(request, credential)
	response, err := client.UpdateProviderInstance(ctx, request)
	if err != nil {
		return UpdateProviderInstanceResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return UpdateProviderInstanceResult{}, clierror.Unexpected(errors.New("invalid provider-instance response"))
	}
	instance, err := mapProviderInstance(response.Msg.GetProviderInstance())
	if err != nil {
		return UpdateProviderInstanceResult{}, err
	}
	return UpdateProviderInstanceResult{OperationID: operationID, ProviderInstance: instance}, nil
}

// DeleteProviderInstance permanently removes one disabled provider instance.
func DeleteProviderInstance(
	ctx context.Context,
	input DeleteProviderInstanceInput,
	client apiv1.ProviderServiceClient,
	credentials auth.CredentialStore,
) (DeleteProviderInstanceResult, error) {
	credential, err := providerCredential(ctx, input.Profile, input.Server, credentials)
	if err != nil {
		return DeleteProviderInstanceResult{}, err
	}
	operationID := input.OperationID
	if operationID == "" {
		operationID, err = newOperationID()
		if err != nil {
			return DeleteProviderInstanceResult{}, clierror.Unexpected(err)
		}
	}
	request := connect.NewRequest(&apiv1.DeleteProviderInstanceRequest{
		OperationId:        operationID,
		ProviderInstanceId: input.ProviderInstanceID,
		ExpectedRevision:   input.ExpectedRevision,
	})
	attachProviderCredential(request, credential)
	response, err := client.DeleteProviderInstance(ctx, request)
	if err != nil {
		return DeleteProviderInstanceResult{}, clierror.Translate(err)
	}
	if response == nil || response.Msg == nil {
		return DeleteProviderInstanceResult{}, clierror.Unexpected(errors.New("invalid provider-instance deletion response"))
	}
	return DeleteProviderInstanceResult{OperationID: operationID}, nil
}

func newOperationID() (string, error) {
	var entropy [24]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(entropy[:]), nil
}

func mapProviderConnectionTest(value *apiv1.ProviderConnectionTest) (ProviderConnectionTest, error) {
	if value == nil {
		return ProviderConnectionTest{}, clierror.Unexpected(errors.New("invalid provider connection test"))
	}
	status, known := providerConnectionStatusName(value.GetStatus())
	if !known {
		return ProviderConnectionTest{}, clierror.Unexpected(errors.New("invalid provider connection status"))
	}
	capabilities := make([]string, 0, len(value.GetCapabilities()))
	for _, capability := range value.GetCapabilities() {
		name, known := providerCapabilityName(capability)
		if known {
			capabilities = append(capabilities, name)
		}
	}
	return ProviderConnectionTest{
		Status:        status,
		Summary:       value.GetSummary(),
		RemoteName:    value.GetRemoteName(),
		RemoteVersion: value.GetRemoteVersion(),
		Capabilities:  capabilities,
	}, nil
}

func providerConnectionStatusName(status apiv1.ProviderConnectionStatus) (string, bool) {
	switch status {
	case apiv1.ProviderConnectionStatus_PROVIDER_CONNECTION_STATUS_CONNECTED:
		return "connected", true
	case apiv1.ProviderConnectionStatus_PROVIDER_CONNECTION_STATUS_AUTHENTICATION_FAILED:
		return "authentication_failed", true
	case apiv1.ProviderConnectionStatus_PROVIDER_CONNECTION_STATUS_UNREACHABLE:
		return "unreachable", true
	case apiv1.ProviderConnectionStatus_PROVIDER_CONNECTION_STATUS_INCOMPATIBLE:
		return "incompatible", true
	default:
		return "", false
	}
}

func mapProviderInstance(value *apiv1.ProviderInstance) (ProviderInstance, error) {
	if value == nil || value.GetConfiguration() == nil {
		return ProviderInstance{}, clierror.Unexpected(errors.New("invalid provider instance"))
	}
	createdAt := value.GetCreatedAt()
	updatedAt := value.GetUpdatedAt()
	if createdAt == nil || createdAt.CheckValid() != nil || updatedAt == nil || updatedAt.CheckValid() != nil {
		return ProviderInstance{}, clierror.Unexpected(errors.New("invalid provider-instance timestamp"))
	}
	status, known := providerInstanceStatusName(value.GetStatus())
	if !known {
		return ProviderInstance{}, clierror.Unexpected(errors.New("invalid provider-instance status"))
	}
	configuredSecrets := make([]ConfiguredSecret, 0, len(value.GetConfiguredSecrets()))
	for _, secret := range value.GetConfiguredSecrets() {
		if secret == nil {
			return ProviderInstance{}, clierror.Unexpected(errors.New("invalid configured-secret marker"))
		}
		configuredSecrets = append(configuredSecrets, ConfiguredSecret{
			Key: secret.GetKey(), Configured: secret.GetConfigured(),
		})
	}
	return ProviderInstance{
		ID:                value.GetId(),
		ProviderTypeID:    value.GetProviderTypeId(),
		DisplayName:       value.GetDisplayName(),
		Enabled:           value.GetEnabled(),
		SyncPriority:      value.GetSyncPriority(),
		Status:            status,
		Configuration:     value.GetConfiguration().AsMap(),
		ConfiguredSecrets: configuredSecrets,
		Revision:          value.GetRevision(),
		CreatedAt:         createdAt.AsTime().UTC(),
		UpdatedAt:         updatedAt.AsTime().UTC(),
	}, nil
}

func providerInstanceStatusName(status apiv1.ProviderInstanceStatus) (string, bool) {
	switch status {
	case apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_HEALTHY:
		return "healthy", true
	case apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_UNAVAILABLE:
		return "unavailable", true
	case apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_AUTHENTICATION_FAILED:
		return "authentication_failed", true
	case apiv1.ProviderInstanceStatus_PROVIDER_INSTANCE_STATUS_DISABLED:
		return "disabled", true
	default:
		return "", false
	}
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
