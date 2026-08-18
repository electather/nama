// Package auth constructs the authentication resource commands.
package auth

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
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
		Long:  "Manage Administrator authentication. Sign in with a password or inspect the current process or native-store credential.",
		Args:  noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.InvalidArguments(command, errors.New("an auth subcommand is required"))
		},
	}

	var email string
	login := &cobra.Command{
		Use:   "login",
		Short: "Sign in as an Administrator",
		Long: `Sign in with the Administrator email and a password.

Human terminal input reads the password through a labelled hidden prompt.
Non-interactive input reads exactly one password line from redirected stdin.
JSON output with terminal stdin is rejected before the password is read.`,
		Example: "  nama auth login --profile local --email admin@example.test\n  printf '%s\\n' \"$NAMA_ADMIN_PASSWORD\" | nama auth login --profile local --email admin@example.test --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			if email == "" {
				return handlers.InvalidArguments(command, errors.New("--email is required"))
			}
			return handlers.Login(command, email)
		},
	}
	login.Flags().StringVar(&email, "email", "", "Administrator email address (required)")
	surface.SetFlag(login, "email", surface.FlagMetadata{Required: true})
	surface.SetInputs(login, surface.PasswordInput("Administrator password"))
	status := &cobra.Command{
		Use:     "status",
		Short:   "Report authentication status",
		Long:    "Report whether an Administrator credential is active. NAMA_TOKEN may inject a process-only bearer instead of reading native credential storage.",
		Example: "  nama auth status --profile local\n  NAMA_TOKEN=\"$NAMA_TOKEN\" nama auth status --server https://nama.example.test --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.Status(command)
		},
	}
	surface.SetInputs(status, surface.Input{
		Name:        "bearer",
		Type:        "string",
		Required:    false,
		Secret:      true,
		Description: "Administrator bearer credential",
		Sources: []surface.InputSource{
			{Kind: surface.InputSourceKindEnvironment, Name: "NAMA_TOKEN", Condition: surface.InputSourceConditionAlways},
			{Kind: surface.InputSourceKindNativeCredentialStore, Name: "operating_system", Condition: surface.InputSourceConditionNAMATokenUnset},
		},
	})
	command.AddCommand(login, status)
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
