// Package provider constructs provider-neutral management commands.
package provider

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
	"github.com/spf13/cobra"
)

// CreateInstanceInput is the complete command-layer provider create invocation.
type CreateInstanceInput struct {
	ProviderTypeID    string
	DisplayName       string
	ConfigurationPath string
	OperationID       string
	Enabled           bool
	SyncPriority      *uint32
}

// UpdateInstanceInput is one explicit provider-instance patch.
type UpdateInstanceInput struct {
	ProviderInstanceID       string
	ExpectedRevision         string
	ConfigurationPatchPath   string
	ClearConfigurationFields []string
	OperationID              string
	DisplayName              *string
	Enabled                  *bool
	SyncPriority             *uint32
}

// DeleteInstanceInput is one confirmed provider-instance deletion.
type DeleteInstanceInput struct {
	ProviderInstanceID string
	ExpectedRevision   string
	OperationID        string
	Yes                bool
}

// Handlers bind provider command inputs to the CLI composition root.
type Handlers struct {
	CreateInstance   func(*cobra.Command, CreateInstanceInput) error
	DeleteInstance   func(*cobra.Command, DeleteInstanceInput) error
	GetInstance      func(*cobra.Command, string) error
	ListInstances    func(*cobra.Command, uint32, string) error
	ListTypes        func(*cobra.Command, uint32, string) error
	UpdateInstance   func(*cobra.Command, UpdateInstanceInput) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the implemented provider management command family.
func NewCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:   "provider",
		Short: "Manage provider resources",
		Long:  "Discover and manage provider-neutral resources recognized by the selected Nama server.",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("a provider subcommand is required"))
		},
	}
	command.AddCommand(newTypeCommand(handlers), newInstanceCommand(handlers))
	return command
}

func newTypeCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:   "type",
		Short: "Inspect installed provider types",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("a provider type subcommand is required"))
		},
	}
	var pageSize uint32
	var pageToken string
	list := &cobra.Command{
		Use:     "list",
		Short:   "List installed provider types",
		Long:    "List the provider-neutral types and accepted configuration schemas recognized by the selected authenticated Nama server.",
		Example: "  nama provider type list --profile local\n  nama provider type list --profile local --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.ListTypes(command, pageSize, pageToken)
		},
	}
	list.Flags().Uint32Var(&pageSize, "page-size", 0, "Request up to 100 provider types; zero uses the server default")
	list.Flags().StringVar(&pageToken, "page-token", "", "Continue an earlier provider type list")
	surface.SetFlag(list, "page-size", surface.FlagMetadata{Default: "0"})
	surface.SetFlag(list, "page-token", surface.FlagMetadata{})
	setBearerInput(list)
	command.AddCommand(list)
	return command
}

func newInstanceCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:   "instance",
		Short: "Manage configured provider instances",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("a provider instance subcommand is required"))
		},
	}
	command.AddCommand(
		newCreateInstanceCommand(handlers),
		newDeleteInstanceCommand(handlers),
		newGetInstanceCommand(handlers),
		newListInstancesCommand(handlers),
		newUpdateInstanceCommand(handlers),
	)
	return command
}

func newCreateInstanceCommand(handlers Handlers) *cobra.Command {
	var configuration string
	var displayName string
	var enabled bool
	var operationID string
	var syncPriority uint32
	command := &cobra.Command{
		Use:     "create <provider-type-id>",
		Short:   "Create a verified provider instance",
		Long:    "Create a provider-neutral instance from one complete configuration. Interactive human use may render the accepted provider schema; JSON and non-interactive use read a JSON document from --configuration. Secret values belong only in prompts or that document.",
		Example: "  nama provider instance create jellyfin --display-name Home --profile local\n  nama provider instance create jellyfin --display-name Home --configuration provider.json --profile local\n  cat provider.json | nama provider instance create jellyfin --display-name Home --configuration - --profile local --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handlers.InvalidArguments(command, errors.New("exactly one provider type ID is required"))
			}
			if displayName == "" {
				return handlers.InvalidArguments(command, errors.New("--display-name is required"))
			}
			if command.Flags().Changed("sync-priority") && syncPriority == 0 {
				return handlers.InvalidArguments(command, errors.New("--sync-priority must be positive"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			var priority *uint32
			if command.Flags().Changed("sync-priority") {
				priority = new(syncPriority)
			}
			return handlers.CreateInstance(command, CreateInstanceInput{
				ProviderTypeID:    arguments[0],
				DisplayName:       displayName,
				ConfigurationPath: configuration,
				OperationID:       operationID,
				Enabled:           enabled,
				SyncPriority:      priority,
			})
		},
	}
	command.Flags().StringVar(&configuration, "configuration", "", "Read the complete JSON configuration from this file path or - for standard input (required for JSON or non-interactive use)")
	command.Flags().StringVar(&displayName, "display-name", "", "Provider instance display name (required)")
	command.Flags().BoolVar(&enabled, "enabled", true, "Create the provider instance enabled")
	command.Flags().StringVar(&operationID, "operation-id", "", "Reuse this opaque operation ID for an exact retry; omitted generates one")
	command.Flags().Uint32Var(&syncPriority, "sync-priority", 0, "Set a positive synchronization priority; omitted allocates the next priority")
	surface.SetArguments(command, surface.Argument{
		Name: "provider-type-id", Type: "string", Required: true,
		Description: "Opaque installed provider type ID",
	})
	surface.SetFlag(command, "configuration", surface.FlagMetadata{})
	surface.SetFlag(command, "display-name", surface.FlagMetadata{Required: true})
	surface.SetFlag(command, "enabled", surface.FlagMetadata{Default: "true"})
	surface.SetFlag(command, "operation-id", surface.FlagMetadata{})
	surface.SetFlag(command, "sync-priority", surface.FlagMetadata{})
	setBearerInput(command)
	return command
}

func newDeleteInstanceCommand(handlers Handlers) *cobra.Command {
	var expectedRevision string
	var operationID string
	var yes bool
	command := &cobra.Command{
		Use:     "delete <provider-instance-id>",
		Short:   "Permanently delete a disabled provider instance",
		Long:    "Permanently remove a disabled provider instance and its Nama-owned state. Interactive human use prompts for confirmation; JSON and non-interactive use require --yes.",
		Example: "  nama provider instance delete <provider-instance-id> --expected-revision <revision> --profile local\n  nama provider instance delete <provider-instance-id> --expected-revision <revision> --yes --profile local --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handlers.InvalidArguments(command, errors.New("exactly one provider instance ID is required"))
			}
			if expectedRevision == "" {
				return handlers.InvalidArguments(command, errors.New("--expected-revision is required"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			return handlers.DeleteInstance(command, DeleteInstanceInput{
				ProviderInstanceID: arguments[0],
				ExpectedRevision:   expectedRevision,
				OperationID:        operationID,
				Yes:                yes,
			})
		},
	}
	command.Flags().StringVar(&expectedRevision, "expected-revision", "", "Require this current provider-instance revision (required)")
	command.Flags().StringVar(&operationID, "operation-id", "", "Reuse this opaque operation ID for an exact retry; omitted generates one")
	command.Flags().BoolVar(&yes, "yes", false, "Confirm permanent deletion without prompting (required for JSON or non-interactive use)")
	surface.SetArguments(command, surface.Argument{
		Name: "provider-instance-id", Type: "string", Required: true,
		Description: "Opaque provider instance ID",
	})
	surface.SetFlag(command, "expected-revision", surface.FlagMetadata{Required: true})
	surface.SetFlag(command, "operation-id", surface.FlagMetadata{})
	surface.SetFlag(command, "yes", surface.FlagMetadata{Default: "false"})
	setBearerInput(command)
	return command
}

func newGetInstanceCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:     "get <provider-instance-id>",
		Short:   "Inspect one provider instance",
		Long:    "Inspect one provider-neutral instance without returning write-only configuration values or credentials.",
		Example: "  nama provider instance get <provider-instance-id> --profile local --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handlers.InvalidArguments(command, errors.New("exactly one provider instance ID is required"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			return handlers.GetInstance(command, arguments[0])
		},
	}
	surface.SetArguments(command, surface.Argument{
		Name: "provider-instance-id", Type: "string", Required: true,
		Description: "Opaque provider instance ID",
	})
	setBearerInput(command)
	return command
}

func newListInstancesCommand(handlers Handlers) *cobra.Command {
	var pageSize uint32
	var pageToken string
	command := &cobra.Command{
		Use:     "list",
		Short:   "List provider instances",
		Long:    "List one page of provider-neutral instances without returning write-only configuration values or credentials.",
		Example: "  nama provider instance list --profile local --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.ListInstances(command, pageSize, pageToken)
		},
	}
	command.Flags().Uint32Var(&pageSize, "page-size", 0, "Request up to 100 provider instances; zero uses the server default")
	command.Flags().StringVar(&pageToken, "page-token", "", "Continue an earlier provider instance list")
	surface.SetFlag(command, "page-size", surface.FlagMetadata{Default: "0"})
	surface.SetFlag(command, "page-token", surface.FlagMetadata{})
	setBearerInput(command)
	return command
}

func newUpdateInstanceCommand(handlers Handlers) *cobra.Command {
	var clearConfigurationFields []string
	var configurationPatch string
	var displayName string
	var enabled bool
	var expectedRevision string
	var operationID string
	var syncPriority uint32
	command := &cobra.Command{
		Use:     "update <provider-instance-id>",
		Short:   "Update a provider instance",
		Long:    "Patch provider-neutral metadata or configuration. Interactive human use with no update flags renders the accepted provider schema; --configuration reads a JSON patch from a file path or - for standard input. Omitted configuration and credentials remain unchanged.",
		Example: "  nama provider instance update <provider-instance-id> --expected-revision <revision> --profile local\n  nama provider instance update <provider-instance-id> --expected-revision <revision> --display-name Family --profile local\n  cat patch.json | nama provider instance update <provider-instance-id> --expected-revision <revision> --configuration - --profile local --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handlers.InvalidArguments(command, errors.New("exactly one provider instance ID is required"))
			}
			if expectedRevision == "" {
				return handlers.InvalidArguments(command, errors.New("--expected-revision is required"))
			}
			if command.Flags().Changed("display-name") && displayName == "" {
				return handlers.InvalidArguments(command, errors.New("--display-name must not be empty"))
			}
			if command.Flags().Changed("sync-priority") && syncPriority == 0 {
				return handlers.InvalidArguments(command, errors.New("--sync-priority must be positive"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			input := UpdateInstanceInput{
				ProviderInstanceID:       arguments[0],
				ExpectedRevision:         expectedRevision,
				ConfigurationPatchPath:   configurationPatch,
				ClearConfigurationFields: clearConfigurationFields,
				OperationID:              operationID,
			}
			if command.Flags().Changed("display-name") {
				input.DisplayName = new(displayName)
			}
			if command.Flags().Changed("enabled") {
				input.Enabled = new(enabled)
			}
			if command.Flags().Changed("sync-priority") {
				input.SyncPriority = new(syncPriority)
			}
			return handlers.UpdateInstance(command, input)
		},
	}
	command.Flags().StringArrayVar(&clearConfigurationFields, "clear", nil, "Explicitly clear one optional configuration field; repeat for multiple fields")
	command.Flags().StringVar(&configurationPatch, "configuration", "", "Read a JSON configuration patch from this file path or - for standard input")
	command.Flags().StringVar(&displayName, "display-name", "", "Replace the provider instance display name")
	command.Flags().BoolVar(&enabled, "enabled", false, "Enable or disable the provider instance")
	command.Flags().StringVar(&expectedRevision, "expected-revision", "", "Require this current provider-instance revision (required)")
	command.Flags().StringVar(&operationID, "operation-id", "", "Reuse this opaque operation ID for an exact retry; omitted generates one")
	command.Flags().Uint32Var(&syncPriority, "sync-priority", 0, "Set a positive synchronization priority")
	surface.SetArguments(command, surface.Argument{
		Name: "provider-instance-id", Type: "string", Required: true,
		Description: "Opaque provider instance ID",
	})
	surface.SetFlag(command, "clear", surface.FlagMetadata{})
	surface.SetFlag(command, "configuration", surface.FlagMetadata{})
	surface.SetFlag(command, "display-name", surface.FlagMetadata{})
	surface.SetFlag(command, "enabled", surface.FlagMetadata{})
	surface.SetFlag(command, "expected-revision", surface.FlagMetadata{Required: true})
	surface.SetFlag(command, "operation-id", surface.FlagMetadata{})
	surface.SetFlag(command, "sync-priority", surface.FlagMetadata{})
	setBearerInput(command)
	return command
}

func setBearerInput(command *cobra.Command) {
	surface.SetInputs(command, surface.Input{
		Name:        "bearer",
		Type:        "string",
		Required:    true,
		Secret:      true,
		Description: "Administrator bearer credential",
		Sources: []surface.InputSource{
			{Kind: surface.InputSourceKindEnvironment, Name: "NAMA_TOKEN", Condition: surface.InputSourceConditionAlways},
			{Kind: surface.InputSourceKindNativeCredentialStore, Name: "operating_system", Condition: surface.InputSourceConditionNAMATokenUnset},
		},
	})
}

func noArgs(handlers Handlers) cobra.PositionalArgs {
	return func(command *cobra.Command, arguments []string) error {
		if len(arguments) == 0 {
			return nil
		}
		return handlers.InvalidArguments(command, errors.New("this command accepts no arguments"))
	}
}
