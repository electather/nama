// Package setup constructs the setup command.
package setup

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
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
		Short: "Initialize the Administrator account",
		Long: `Initialize the sole Administrator account.

Human terminal input reads the bootstrap token and password through labelled
hidden prompts. Non-interactive input reads NAMA_BOOTSTRAP_TOKEN from the
environment and exactly one password line from redirected stdin. JSON output
with terminal stdin is rejected before either secret is read.`,
		Example: `  nama setup --profile local --display-name "Nama Administrator" --email admin@example.test
  printf '%s\n' "$NAMA_ADMIN_PASSWORD" | NAMA_BOOTSTRAP_TOKEN="$NAMA_BOOTSTRAP_TOKEN" nama setup --profile local --display-name "Nama Administrator" --email admin@example.test --output json`,
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 0 {
				return handler.InvalidArguments(command, errors.New("this command accepts no arguments"))
			}
			if displayName == "" || email == "" {
				return handler.InvalidArguments(command, errors.New("--display-name and --email are required"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, _ []string) error {
			return handler.Run(command, displayName, email)
		},
	}
	command.Flags().StringVar(&displayName, "display-name", "", "Administrator display name (required)")
	command.Flags().StringVar(&email, "email", "", "Administrator email address (required)")
	surface.SetFlag(command, "display-name", surface.FlagMetadata{Required: true})
	surface.SetFlag(command, "email", surface.FlagMetadata{Required: true})
	surface.SetInputs(command,
		surface.Input{
			Name:        "bootstrap_token",
			Type:        "string",
			Required:    true,
			Secret:      true,
			Description: "One-time server bootstrap token",
			Sources: []surface.InputSource{
				{Kind: "hidden_prompt", Name: "Bootstrap token", Condition: "human_terminal"},
				{Kind: "environment", Name: "NAMA_BOOTSTRAP_TOKEN", Condition: "nonterminal"},
				{Kind: "rejected", Name: "terminal_stdin", Condition: "json_terminal"},
			},
		},
		surface.Input{
			Name:        "password",
			Type:        "string",
			Required:    true,
			Secret:      true,
			Description: "Initial Administrator password",
			Sources: []surface.InputSource{
				{Kind: "hidden_prompt", Name: "Password", Condition: "human_terminal"},
				{Kind: "stdin_line", Name: "stdin", Condition: "nonterminal"},
				{Kind: "rejected", Name: "terminal_stdin", Condition: "json_terminal"},
			},
		},
	)
	return command
}
