// Package profile constructs the profile resource commands.
package profile

import (
	"errors"

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
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("a profile subcommand is required"))
		},
	}
	command.AddCommand(
		&cobra.Command{
			Use:   "set <name>",
			Short: "Create or update a server profile",
			Args:  exactArgs(handlers, 1),
			RunE: func(command *cobra.Command, arguments []string) error {
				return handlers.Set(command, arguments[0])
			},
		},
		&cobra.Command{
			Use:   "use <name>",
			Short: "Select the default server profile",
			Args:  exactArgs(handlers, 1),
			RunE: func(command *cobra.Command, arguments []string) error {
				return handlers.Use(command, arguments[0])
			},
		},
		&cobra.Command{
			Use:   "list",
			Short: "List configured server profiles",
			Args:  noArgs(handlers),
			RunE: func(command *cobra.Command, _ []string) error {
				return handlers.List(command)
			},
		},
	)
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
