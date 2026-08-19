// Package provider constructs provider-neutral management commands.
package provider

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
	"github.com/spf13/cobra"
)

// Handlers bind provider command inputs to the CLI composition root.
type Handlers struct {
	ListTypes        func(*cobra.Command, uint32, string) error
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
	typeCommand := &cobra.Command{
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
	surface.SetInputs(list, surface.Input{
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
	typeCommand.AddCommand(list)
	command.AddCommand(typeCommand)
	return command
}

func noArgs(handlers Handlers) cobra.PositionalArgs {
	return func(command *cobra.Command, arguments []string) error {
		if len(arguments) == 0 {
			return nil
		}
		return handlers.InvalidArguments(command, errors.New("this command accepts no arguments"))
	}
}
