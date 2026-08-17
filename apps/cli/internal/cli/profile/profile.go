// Package profile constructs the profile resource commands.
package profile

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
	"github.com/spf13/cobra"
)

// Handlers bind profile command inputs to the CLI composition root.
type Handlers struct {
	Set              func(*cobra.Command, string) error
	Use              func(*cobra.Command, string) error
	List             func(*cobra.Command) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the profile command family.
func NewCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:   "profile",
		Short: "Manage server profiles",
		Long:  "Manage named server profiles. Profiles store non-secret server targets; credentials remain in native credential storage.",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("a profile subcommand is required"))
		},
	}
	set := &cobra.Command{
		Use:     "set <name>",
		Short:   "Create or update a server profile",
		Long:    "Create or update the profile name supplied as <name>. The server target resolves from --server before NAMA_SERVER.",
		Example: "  nama profile set local --server https://nama.example.test",
		Args:    exactArgs(handlers, 1),
		RunE: func(command *cobra.Command, arguments []string) error {
			return handlers.Set(command, arguments[0])
		},
	}
	surface.SetArguments(set, surface.Argument{
		Name:        "name",
		Type:        "string",
		Required:    true,
		Description: "Stable profile name",
	})
	use := &cobra.Command{
		Use:     "use <name>",
		Short:   "Select the default server profile",
		Long:    "Select the profile name supplied as <name> as the default for later commands.",
		Example: "  nama profile use local",
		Args:    exactArgs(handlers, 1),
		RunE: func(command *cobra.Command, arguments []string) error {
			return handlers.Use(command, arguments[0])
		},
	}
	surface.SetArguments(use, surface.Argument{
		Name:        "name",
		Type:        "string",
		Required:    true,
		Description: "Configured profile name",
	})
	list := &cobra.Command{
		Use:     "list",
		Short:   "List configured server profiles",
		Long:    "List configured profiles and identify the selected default profile.",
		Example: "  nama profile list\n  nama profile list --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.List(command)
		},
	}
	command.AddCommand(set, use, list)
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

func exactArgs(handlers Handlers, count int) cobra.PositionalArgs {
	return func(command *cobra.Command, arguments []string) error {
		if len(arguments) == count {
			return nil
		}
		return handlers.InvalidArguments(command, errors.New("incorrect number of arguments"))
	}
}
