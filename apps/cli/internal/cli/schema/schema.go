// Package schema constructs the machine-discovery command.
package schema

import (
	"errors"

	"github.com/spf13/cobra"
)

// Handler binds schema extraction to the CLI composition root.
type Handler struct {
	Run              func(*cobra.Command) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the command-schema surface.
func NewCommand(handler Handler) *cobra.Command {
	return &cobra.Command{
		Use:     "schema",
		Short:   "Describe the public CLI command contract",
		Long:    "Print a compact human command inventory or schema version 1 as one JSON data envelope for machine discovery.",
		Example: "  nama schema\n  nama schema --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) == 0 {
				return nil
			}
			return handler.InvalidArguments(command, errors.New("this command accepts no arguments"))
		},
		RunE: func(command *cobra.Command, _ []string) error {
			return handler.Run(command)
		},
	}
}
