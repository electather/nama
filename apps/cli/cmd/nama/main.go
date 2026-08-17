package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/cli"
	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/electather/nama/apps/cli/internal/output"
	"golang.org/x/term"
)

func main() {
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		mode := output.Human
		if explicitMode, ok := cli.ExplicitOutputMode(os.Args[1:]); ok {
			mode = explicitMode
		} else if os.Getenv("NAMA_OUTPUT") == "json" {
			mode = output.JSON
		}
		exitWithConfigurationError(err, mode)
	}

	command := cli.NewRootCommand(cli.Dependencies{
		ConfigPath:  filepath.Join(configDirectory, "nama", "config.json"),
		Credentials: auth.NewCredentialStore(auth.NativeKeyring{}, os.Getenv),
		SecretInput: auth.SecretInput{
			Stdin:    os.Stdin,
			Terminal: term.IsTerminal(int(os.Stdin.Fd())),
			Getenv:   os.Getenv,
		},
		HTTPClient: http.DefaultClient,
		RawArgs:    os.Args[1:],
	})
	command.SetArgs(os.Args[1:])
	command.SetIn(os.Stdin)
	command.SetOut(os.Stdout)
	command.SetErr(os.Stderr)

	if err := command.ExecuteContext(context.Background()); err != nil {
		os.Exit(clierror.Translate(err).ExitCode())
	}
}

func exitWithConfigurationError(cause error, mode output.Mode) {
	failure := clierror.InvalidConfiguration(cause)
	_ = output.New(mode, os.Stdout, os.Stderr).Failure(failure)
	os.Exit(failure.ExitCode())
}
