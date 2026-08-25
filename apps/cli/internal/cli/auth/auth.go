// Package auth constructs the authentication resource commands.
package auth

import (
	"errors"

	"github.com/electather/nama/apps/cli/internal/surface"
	"github.com/spf13/cobra"
)

// Handlers bind authentication command inputs to the CLI composition root.
type Handlers struct {
	ApproveDevice     func(*cobra.Command, string) error
	Login             func(*cobra.Command, string) error
	RevokeAppleClient func(*cobra.Command, bool) error
	Status            func(*cobra.Command) error
	InvalidArguments  func(*cobra.Command, error) error
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
	bearerInput := surface.Input{
		Name:        "bearer",
		Type:        "string",
		Required:    false,
		Secret:      true,
		Description: "Signed Nama session bearer credential",
		Sources: []surface.InputSource{
			{Kind: surface.InputSourceKindEnvironment, Name: "NAMA_TOKEN", Condition: surface.InputSourceConditionAlways},
			{Kind: surface.InputSourceKindNativeCredentialStore, Name: "operating_system", Condition: surface.InputSourceConditionNAMATokenUnset},
		},
	}
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
	surface.SetInputs(status, bearerInput)
	approveDevice := &cobra.Command{
		Use:     "approve-device <user-code>",
		Short:   "Approve Apple device authorization",
		Long:    "Approve the displayed Apple device-authorization user code for the current signed-in user. Uses the selected profile credential or NAMA_TOKEN and never reads a password.",
		Example: "  nama auth approve-device ABCD-EFGH --profile local\n  NAMA_TOKEN=\"$NAMA_TOKEN\" nama auth approve-device ABCD-EFGH --server https://nama.example.test --output json",
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handlers.InvalidArguments(command, errors.New("exactly one user code is required"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			return handlers.ApproveDevice(command, arguments[0])
		},
	}
	surface.SetArguments(approveDevice, surface.Argument{
		Name:        "user-code",
		Type:        "string",
		Required:    true,
		Description: "User code displayed by the Apple app",
	})
	surface.SetInputs(approveDevice, bearerInput)
	var yes bool
	revokeAppleClient := &cobra.Command{
		Use:     "revoke-apple-client",
		Short:   "Revoke Apple refresh tokens",
		Long:    "Revoke every refresh-token family for the fixed Apple public client. Existing access tokens remain valid until expiry. Interactive human use prompts for confirmation; JSON and non-interactive use require --yes.",
		Example: "  nama auth revoke-apple-client --profile local\n  nama auth revoke-apple-client --yes --profile local --output json",
		Args:    noArgs(handlers),
		RunE: func(command *cobra.Command, _ []string) error {
			return handlers.RevokeAppleClient(command, yes)
		},
	}
	revokeAppleClient.Flags().BoolVar(&yes, "yes", false, "Confirm broad Apple refresh-token revocation without prompting")
	surface.SetInputs(revokeAppleClient, bearerInput)
	command.AddCommand(approveDevice, login, revokeAppleClient, status)
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
