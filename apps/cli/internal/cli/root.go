// Package cli constructs the Nama Cobra command tree.
package cli

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/electather/nama/apps/cli/internal/api"
	"github.com/electather/nama/apps/cli/internal/app"
	credentialauth "github.com/electather/nama/apps/cli/internal/auth"
	authcommand "github.com/electather/nama/apps/cli/internal/cli/auth"
	profilecommand "github.com/electather/nama/apps/cli/internal/cli/profile"
	setupcommand "github.com/electather/nama/apps/cli/internal/cli/setup"
	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/electather/nama/apps/cli/internal/config"
	"github.com/electather/nama/apps/cli/internal/output"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"github.com/spf13/cobra"
)

const insecureTransportMessage = "Plain HTTP is not encrypted."

// Dependencies supplies the concrete process dependencies for the command tree.
type Dependencies struct {
	ConfigPath  string
	Credentials credentialauth.CredentialStore
	SetupClient apiv1.SetupServiceClient
	AuthClient  apiv1.AuthServiceClient
	SecretInput credentialauth.SecretInput
	HTTPClient  *http.Client
	RawArgs     []string
}

type runtime struct {
	dependencies Dependencies
	store        *config.Store
	profiles     *app.ProfileService

	profile string
	server  string
	output  string
}

type commandState struct {
	config   config.Config
	resolved config.Resolved
}

type profileListResult struct {
	Profiles []app.Profile `json:"profiles"`
}

// NewRootCommand constructs the complete Nama command tree.
func NewRootCommand(dependencies Dependencies) *cobra.Command {
	runtime := &runtime{
		dependencies: dependencies,
		store:        config.NewStore(dependencies.ConfigPath),
	}
	runtime.profiles = app.NewProfileService(
		runtime.store,
		profileCredentials{store: dependencies.Credentials},
	)

	root := &cobra.Command{
		Use:   "nama",
		Short: "Manage a Nama server",
		Args:  runtime.rootArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&runtime.profile, "profile", "", "Server profile")
	root.PersistentFlags().StringVar(&runtime.server, "server", "", "Server URL")
	root.PersistentFlags().StringVar(&runtime.output, "output", "", "Output format (human or json)")
	root.SetFlagErrorFunc(runtime.flagError)
	root.AddCommand(
		profilecommand.NewCommand(profilecommand.Handlers{
			Set:              runtime.setProfile,
			Use:              runtime.useProfile,
			List:             runtime.listProfiles,
			InvalidArguments: runtime.invalidArguments,
		}),
		setupcommand.NewCommand(setupcommand.Handler{
			Run:              runtime.setup,
			InvalidArguments: runtime.invalidArguments,
		}),
		authcommand.NewCommand(authcommand.Handlers{
			Login:            runtime.login,
			Status:           runtime.status,
			InvalidArguments: runtime.invalidArguments,
		}),
	)
	return root
}

func (r *runtime) rootArgs(command *cobra.Command, arguments []string) error {
	if len(arguments) == 0 {
		return nil
	}
	return r.invalidArguments(command, errors.New("this command accepts no arguments"))
}

func (r *runtime) flagError(command *cobra.Command, cause error) error {
	return r.invalidArguments(command, cause)
}

func (r *runtime) invalidArguments(command *cobra.Command, cause error) error {
	return r.failure(command, r.failureMode(), clierror.InvalidArgument(cause))
}

func (r *runtime) setProfile(command *cobra.Command, name string) error {
	return r.executeProfile(command, true, true, func(state commandState) (any, error) {
		if !r.serverOverride(command) || state.resolved.Server == "" {
			return nil, clierror.InvalidArgument(errors.New("profile set requires a server URL"))
		}
		if err := config.ValidateProfileName(name); err != nil {
			return nil, clierror.InvalidArgument(err)
		}

		result, err := r.profiles.Set(command.Context(), name, state.resolved.Server)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) useProfile(command *cobra.Command, name string) error {
	return r.executeProfile(command, true, false, func(_ commandState) (any, error) {
		if err := config.ValidateProfileName(name); err != nil {
			return nil, clierror.InvalidArgument(err)
		}

		result, err := r.profiles.Use(command.Context(), name)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) listProfiles(command *cobra.Command) error {
	return r.executeProfile(command, false, false, func(_ commandState) (any, error) {
		profiles, err := r.profiles.List(command.Context())
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return profileListResult{Profiles: profiles}, nil
	})
}

func (r *runtime) setup(command *cobra.Command, displayName, email string) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		if displayName == "" || email == "" {
			return nil, clierror.InvalidArgument(errors.New("display name and email are required"))
		}

		secrets, err := credentialauth.ReadSetupSecrets(r.secretInput(command, state))
		if err != nil {
			return nil, classifySecretInputError(err)
		}
		if secrets.BootstrapToken == "" {
			return nil, clierror.InvalidArgument(errors.New("bootstrap token is required"))
		}
		if secrets.Password == "" {
			return nil, clierror.InvalidArgument(errors.New("password is required"))
		}

		setupClient, authClient, err := r.clients(state, true)
		if err != nil {
			return nil, err
		}
		result, err := app.Setup(command.Context(), app.SetupInput{
			Profile:        state.resolved.Profile,
			Server:         state.resolved.Server,
			BootstrapToken: secrets.BootstrapToken,
			DisplayName:    displayName,
			Email:          email,
			Password:       secrets.Password,
		}, setupClient, authClient, r.dependencies.Credentials)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) login(command *cobra.Command, email string) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		if email == "" {
			return nil, clierror.InvalidArgument(errors.New("email is required"))
		}

		password, err := credentialauth.ReadLoginPassword(r.secretInput(command, state))
		if err != nil {
			return nil, classifySecretInputError(err)
		}
		if password == "" {
			return nil, clierror.InvalidArgument(errors.New("password is required"))
		}

		_, authClient, err := r.clients(state, false)
		if err != nil {
			return nil, err
		}
		result, err := app.Login(command.Context(), app.LoginInput{
			Profile:  state.resolved.Profile,
			Server:   state.resolved.Server,
			Email:    email,
			Password: password,
		}, authClient, r.dependencies.Credentials)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) status(command *cobra.Command) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if state.resolved.Server == "" {
			return nil, clierror.InvalidArgument(errors.New("auth status requires a server URL"))
		}

		_, authClient, err := r.clients(state, false)
		if err != nil {
			return nil, err
		}
		result, err := app.Status(command.Context(), app.StatusInput{
			Profile:       state.resolved.Profile,
			ProfileServer: state.config.Profiles[state.resolved.Profile],
			Server:        state.resolved.Server,
		}, authClient, r.dependencies.Credentials)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) execute(command *cobra.Command, includeWarning bool, action func(commandState) (any, error)) error {
	return r.executeResolved(command, includeWarning, r.resolve, action)
}

func (r *runtime) executeProfile(command *cobra.Command, includeWarning, includeServer bool, action func(commandState) (any, error)) error {
	return r.executeResolved(command, includeWarning, func() (commandState, error) {
		return r.resolveProfile(includeServer)
	}, action)
}

func (r *runtime) executeResolved(command *cobra.Command, includeWarning bool, resolve func() (commandState, error), action func(commandState) (any, error)) error {
	if err := r.validatePersistentFlags(command); err != nil {
		return r.failure(command, r.failureMode(), clierror.InvalidArgument(err))
	}

	state, err := resolve()
	if err != nil {
		return r.failure(command, r.failureMode(), err)
	}

	result, err := action(state)
	if err != nil {
		return r.failure(command, output.Mode(state.resolved.Output), err)
	}

	var warnings []output.Warning
	if includeWarning {
		insecureTransport := state.resolved.InsecureTransport
		if profile, ok := result.(app.Profile); ok {
			insecureTransport = strings.HasPrefix(profile.Server, "http://")
		}
		if insecureTransport {
			warnings = []output.Warning{{Code: "insecure_transport", Message: insecureTransportMessage}}
		}
	}
	if err := output.New(output.Mode(state.resolved.Output), command.OutOrStdout(), command.ErrOrStderr()).Success(result, warnings); err != nil {
		return clierror.Unexpected(err)
	}
	return nil
}

func (r *runtime) resolve() (commandState, error) {
	value, err := r.store.Load()
	if err != nil {
		return commandState{}, classifyConfigurationError(err)
	}
	resolved, err := config.Resolve(value, config.ResolutionInput{
		ProfileFlag: r.profile,
		ProfileEnv:  r.getenv("NAMA_PROFILE"),
		ServerFlag:  r.server,
		ServerEnv:   r.getenv("NAMA_SERVER"),
		OutputFlag:  r.output,
		OutputEnv:   r.getenv("NAMA_OUTPUT"),
	})
	if err != nil {
		return commandState{}, classifyResolutionError(err)
	}
	return commandState{config: value, resolved: resolved}, nil
}

func (r *runtime) resolveProfile(includeServer bool) (commandState, error) {
	value, err := r.store.Load()
	if err != nil {
		return commandState{}, classifyConfigurationError(err)
	}
	input := config.ResolutionInput{
		OutputFlag: r.output,
		OutputEnv:  r.getenv("NAMA_OUTPUT"),
	}
	if includeServer {
		input.ServerFlag = r.server
		input.ServerEnv = r.getenv("NAMA_SERVER")
	}
	resolved, err := config.Resolve(config.Config{PreferredOutput: value.PreferredOutput}, input)
	if err != nil {
		return commandState{}, classifyResolutionError(err)
	}
	return commandState{config: value, resolved: resolved}, nil
}

func (r *runtime) validatePersistentFlags(command *cobra.Command) error {
	for _, name := range []string{"server", "profile", "output"} {
		flag := command.Flags().Lookup(name)
		if flag != nil && flag.Changed && flag.Value.String() == "" {
			return errors.New("--" + name + " cannot be empty")
		}
	}
	return nil
}

func (r *runtime) requireProfile(command *cobra.Command, state commandState) error {
	if state.resolved.Profile == "" {
		return clierror.InvalidConfiguration(errors.New("a selected profile is required"))
	}
	if r.serverOverride(command) && state.resolved.Server != state.config.Profiles[state.resolved.Profile] {
		return clierror.InvalidArgument(errors.New("server override differs from selected profile"))
	}
	return nil
}

func (r *runtime) clients(state commandState, needSetup bool) (apiv1.SetupServiceClient, apiv1.AuthServiceClient, error) {
	setupClient := r.dependencies.SetupClient
	authClient := r.dependencies.AuthClient
	if authClient != nil && (!needSetup || setupClient != nil) {
		return setupClient, authClient, nil
	}
	if r.dependencies.HTTPClient == nil {
		return nil, nil, clierror.Unexpected(errors.New("HTTP client is required"))
	}

	clients, err := api.NewClients(r.dependencies.HTTPClient, state.resolved.Server, "")
	if err != nil {
		return nil, nil, clierror.Unexpected(err)
	}
	if setupClient == nil {
		setupClient = clients.Setup
	}
	if authClient == nil {
		authClient = clients.Auth
	}
	return setupClient, authClient, nil
}

func (r *runtime) secretInput(command *cobra.Command, state commandState) credentialauth.SecretInput {
	input := r.dependencies.SecretInput
	input.JSON = state.resolved.Output == config.OutputJSON
	input.Prompt = command.ErrOrStderr()
	return input
}

func classifySecretInputError(cause error) error {
	if errors.Is(cause, credentialauth.ErrBootstrapTokenRequired) || errors.Is(cause, credentialauth.ErrTerminalJSON) {
		return clierror.InvalidArgument(cause)
	}
	return clierror.Unexpected(cause)
}

func (r *runtime) serverOverride(command *cobra.Command) bool {
	if r.server != "" || r.getenv("NAMA_SERVER") != "" {
		return true
	}
	flag := command.Flags().Lookup("server")
	return flag != nil && flag.Changed
}

func (r *runtime) failureMode() output.Mode {
	if mode, ok := ExplicitOutputMode(r.dependencies.RawArgs); ok {
		return mode
	}
	for _, value := range []string{r.output, r.getenv("NAMA_OUTPUT")} {
		if mode, ok := parseOutputMode(value); ok {
			return mode
		}
	}
	if value, err := r.store.Load(); err == nil {
		if mode, ok := parseOutputMode(string(value.PreferredOutput)); ok {
			return mode
		}
	}
	return output.Human
}

// ExplicitOutputMode reports the valid output mode explicitly requested in raw arguments.
func ExplicitOutputMode(arguments []string) (output.Mode, bool) {
	mode := ""
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if argument == "--" {
			break
		}
		switch {
		case argument == "--output":
			if index+1 < len(arguments) && arguments[index+1] != "--" {
				index++
				mode = arguments[index]
			}
		case strings.HasPrefix(argument, "--output="):
			mode = strings.TrimPrefix(argument, "--output=")
		case argument == "--server", argument == "--profile", argument == "--email", argument == "--display-name":
			if index+1 < len(arguments) {
				index++
			}
		}
	}
	return parseOutputMode(mode)
}

func parseOutputMode(value string) (output.Mode, bool) {
	switch value {
	case string(config.OutputHuman):
		return output.Human, true
	case string(config.OutputJSON):
		return output.JSON, true
	default:
		return "", false
	}
}

func (r *runtime) failure(command *cobra.Command, mode output.Mode, cause error) error {
	failure := clierror.Translate(cause)
	if err := output.New(mode, command.OutOrStdout(), command.ErrOrStderr()).Failure(failure); err != nil {
		return clierror.Unexpected(err)
	}
	return failure
}

func (r *runtime) getenv(name string) string {
	if r.dependencies.SecretInput.Getenv == nil {
		return ""
	}
	return r.dependencies.SecretInput.Getenv(name)
}

func classifyConfigurationError(cause error) error {
	if errors.Is(cause, config.ErrMalformed) {
		return clierror.InvalidConfiguration(cause)
	}
	return clierror.Unexpected(cause)
}

func classifyResolutionError(cause error) error {
	if errors.Is(cause, config.ErrMalformed) {
		return clierror.InvalidConfiguration(cause)
	}
	if errors.Is(cause, config.ErrProfileNotFound) {
		return clierror.ProfileNotFound(cause)
	}
	if errors.Is(cause, config.ErrUnsafeTransport) {
		return clierror.UnsafeTransport(cause)
	}
	return clierror.InvalidArgument(cause)
}

func classifyLocalError(cause error) error {
	if errors.Is(cause, config.ErrMalformed) {
		return clierror.InvalidConfiguration(cause)
	}
	if errors.Is(cause, config.ErrProfileNotFound) {
		return clierror.ProfileNotFound(cause)
	}
	return clierror.Translate(cause)
}

type profileCredentials struct {
	store credentialauth.CredentialStore
}

func (c profileCredentials) Delete(ctx context.Context, profile string) error {
	if c.store == nil {
		return clierror.CredentialStoreUnavailable(errors.New("credential store is required"))
	}
	if err := c.store.Delete(ctx, profile); err != nil {
		return clierror.CredentialStoreUnavailable(err)
	}
	return nil
}
