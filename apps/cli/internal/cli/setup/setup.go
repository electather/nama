// Package setup constructs the setup command.
package setup

import (
	"errors"

	"github.com/spf13/cobra"
)

// Handler binds setup command inputs to the CLI composition root.
type Handler struct {
	Run              func(*cobra.Command, string, string) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the setup command.
func NewCommand(handler Handler) *cobra.Command {
	var displayName string
	var email string
	command := &cobra.Command{
		Use:   "setup",
		Short: "Initialize the administrator account",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) == 0 {
				return nil
			}
			return handler.InvalidArguments(command, errors.New("this command accepts no arguments"))
		},
		RunE: func(command *cobra.Command, _ []string) error {
			return handler.Run(command, displayName, email)
		},
	}
	command.Flags().StringVar(&displayName, "display-name", "", "Administrator display name")
	command.Flags().StringVar(&email, "email", "", "Administrator email address")
	return command
}
