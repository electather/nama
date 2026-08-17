// Package auth constructs the authentication resource commands.
package auth

import (
	"errors"

	"github.com/spf13/cobra"
)

// Handlers bind authentication command inputs to the CLI composition root.
type Handlers struct {
	Login            func(*cobra.Command, string) error
	Status           func(*cobra.Command) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the authentication command family.
func NewCommand(handlers Handlers) *cobra.Command {
	command := &cobra.Command{
		Use:   "auth",
		Short: "Manage authentication",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("an auth subcommand is required"))
		},
	}

	var email string
	login := &cobra.Command{
		Use:   "login",
		Short: "Sign in as an administrator",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.Login(command, email)
		},
	}
	login.Flags().StringVar(&email, "email", "", "Administrator email address")

	command.AddCommand(login, &cobra.Command{
		Use:   "status",
		Short: "Report authentication status",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.Status(command)
		},
	})
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
