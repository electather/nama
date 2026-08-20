// Package cli constructs the Nama Cobra command tree.
package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/electather/nama/apps/cli/internal/api"
	"github.com/electather/nama/apps/cli/internal/app"
	credentialauth "github.com/electather/nama/apps/cli/internal/auth"
	authcommand "github.com/electather/nama/apps/cli/internal/cli/auth"
	completioncommand "github.com/electather/nama/apps/cli/internal/cli/completion"
	profilecommand "github.com/electather/nama/apps/cli/internal/cli/profile"
	providercommand "github.com/electather/nama/apps/cli/internal/cli/provider"
	schemacommand "github.com/electather/nama/apps/cli/internal/cli/schema"
	setupcommand "github.com/electather/nama/apps/cli/internal/cli/setup"
	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/electather/nama/apps/cli/internal/config"
	"github.com/electather/nama/apps/cli/internal/output"
	"github.com/electather/nama/apps/cli/internal/surface"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"github.com/spf13/cobra"
)

const insecureTransportMessage = "Plain HTTP is not encrypted."

const rootDescription = `Manage a Nama server through the implemented administration surface.

Configuration precedence
  Profile selection: --profile -> NAMA_PROFILE -> configured default profile.
  Server target: --server -> NAMA_SERVER -> selected profile.
  Output mode: --output -> NAMA_OUTPUT -> configured preferred output -> human.

Output modes
  Human output is the default. Use --output json for one machine-readable
  object on stdout on success or stderr on failure.

Exit codes
  0 success
  1 unexpected failure or cancellation
  2 invalid arguments or configuration
  3 authentication failure
  4 permission denied
  5 resource not found
  6 conflict or invalid state
  7 network or API unavailable, rate limited, or resource exhausted

Examples
  nama profile set local --server https://nama.example.test
  nama setup --profile local --display-name "Nama Administrator" --email admin@example.test
  nama auth login --profile local --email admin@example.test
  nama auth status --profile local`

// Dependencies supplies the concrete process dependencies for the command tree.
type Dependencies struct {
	ConfigPath     string
	Credentials    credentialauth.CredentialStore
	SetupClient    apiv1.SetupServiceClient
	AuthClient     apiv1.AuthServiceClient
	SecretInput    credentialauth.SecretInput
	ProviderClient apiv1.ProviderServiceClient
	HTTPClient     *http.Client
	RawArgs        []string
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

type versionResult struct {
	Version string `json:"version"`
}

type completionResult struct {
	Shell  string `json:"shell"`
	Script string `json:"script"`
}
type helpFlagValue struct {
	runtime *runtime
	value   bool
}

type versionFlagValue struct {
	runtime *runtime
	root    *cobra.Command
	value   bool
}

func (v *helpFlagValue) Set(raw string) error {
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return err
	}
	if !value {
		v.value = false
		return nil
	}
	mode, err := v.runtime.resolveLocalMode()
	if err != nil {
		return err
	}
	if mode == output.JSON {
		return errors.New("JSON help is not supported; use nama schema --output json")
	}
	v.value = true
	return nil
}

func (v *helpFlagValue) String() string {
	return strconv.FormatBool(v.value)
}

func (*helpFlagValue) Type() string {
	return "bool"
}

func (*helpFlagValue) IsBoolFlag() bool {
	return true
}

func (v *versionFlagValue) Set(raw string) error {
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return err
	}
	v.value = value
	if !value {
		return nil
	}
	mode, err := v.runtime.resolveLocalMode()
	if err != nil {
		return err
	}
	template, err := versionTemplate(mode)
	if err != nil {
		return err
	}
	v.root.SetVersionTemplate(template)
	return nil
}

func (v *versionFlagValue) String() string {
	return strconv.FormatBool(v.value)
}

func (*versionFlagValue) Type() string {
	return "bool"
}

func (*versionFlagValue) IsBoolFlag() bool {
	return true
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
		Long:  rootDescription,
		Args:  runtime.rootArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return runtime.root(command)
		},
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&runtime.profile, "profile", "", "Select a server profile (env: NAMA_PROFILE)")
	root.PersistentFlags().StringVar(&runtime.server, "server", "", "Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER)")
	root.PersistentFlags().StringVar(&runtime.output, "output", "", "Select human or json output (env: NAMA_OUTPUT)")
	root.PersistentFlags().Var(&versionFlagValue{runtime: runtime, root: root}, "version", "Print the Nama CLI semantic version")
	root.PersistentFlags().Lookup("version").NoOptDefVal = "true"
	root.PersistentFlags().VarP(&helpFlagValue{runtime: runtime}, "help", "h", "Show help for a command")
	root.PersistentFlags().Lookup("help").NoOptDefVal = "true"
	surface.SetFlag(root, "profile", surface.FlagMetadata{Environment: "NAMA_PROFILE"})
	surface.SetFlag(root, "server", surface.FlagMetadata{Environment: "NAMA_SERVER"})
	surface.SetFlag(root, "output", surface.FlagMetadata{
		Environment:   "NAMA_OUTPUT",
		Default:       "human",
		AllowedValues: []string{"human", "json"},
	})
	surface.SetFlag(root, "version", surface.FlagMetadata{Default: "false"})
	surface.SetFlag(root, "help", surface.FlagMetadata{Default: "false"})
	root.SetFlagErrorFunc(runtime.flagError)
	root.AddCommand(
		completioncommand.NewCommand(completioncommand.Handler{
			Run:              runtime.completion,
			InvalidArguments: runtime.invalidArguments,
		}),
		schemacommand.NewCommand(schemacommand.Handler{
			Run:              runtime.schema,
			InvalidArguments: runtime.invalidArguments,
		}),
		profilecommand.NewCommand(profilecommand.Handlers{
			Set:              runtime.setProfile,
			Use:              runtime.useProfile,
			List:             runtime.listProfiles,
			InvalidArguments: runtime.invalidArguments,
		}),
		providercommand.NewCommand(providercommand.Handlers{
			CreateInstance:   runtime.createProviderInstance,
			DeleteInstance:   runtime.deleteProviderInstance,
			GetInstance:      runtime.getProviderInstance,
			ListInstances:    runtime.listProviderInstances,
			ListTypes:        runtime.listProviderTypes,
			UpdateInstance:   runtime.updateProviderInstance,
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
	helpCommand := runtime.newHelpCommand()
	root.SetHelpCommand(helpCommand)
	setCommandVersions(root, api.Version())
	helpCommand.Version = api.Version()
	return root
}

func (r *runtime) root(command *cobra.Command) error {
	mode, err := r.resolveLocalMode()
	if err != nil {
		return r.failure(command, r.failureMode(), err)
	}
	if mode == output.JSON {
		return r.failure(command, mode, clierror.InvalidArgument(errors.New("a command is required")))
	}
	return command.Help()
}

func versionTemplate(mode output.Mode) (string, error) {
	var rendered bytes.Buffer
	renderer := output.New(mode, &rendered, &rendered)
	var value any = versionResult{Version: api.Version()}
	if mode == output.Human {
		value = api.Version()
	}
	if err := renderer.Success(value, nil); err != nil {
		return "", err
	}
	return rendered.String(), nil
}

func setCommandVersions(command *cobra.Command, version string) {
	command.Version = version
	for _, child := range command.Commands() {
		setCommandVersions(child, version)
	}
}

func (r *runtime) completion(command *cobra.Command, shell string) error {
	mode, err := r.resolveLocalMode()
	if err != nil {
		return r.failure(command, r.failureMode(), err)
	}

	var script bytes.Buffer
	err = completioncommand.Generate(command.Root(), shell, &script)
	if err != nil {
		return r.failure(command, mode, clierror.Unexpected(err))
	}
	result := completionResult{Shell: shell, Script: script.String()}
	if err := output.New(mode, command.OutOrStdout(), command.ErrOrStderr()).SuccessText(result.Script, result); err != nil {
		return r.failure(command, mode, clierror.Unexpected(err))
	}
	return nil
}

func (r *runtime) schema(command *cobra.Command) error {
	mode, err := r.resolveLocalMode()
	if err != nil {
		return r.failure(command, r.failureMode(), err)
	}
	value := surface.Extract(command.Root())
	if err := output.New(mode, command.OutOrStdout(), command.ErrOrStderr()).SuccessText(surface.Inventory(value), value); err != nil {
		return r.failure(command, mode, clierror.Unexpected(err))
	}
	return nil
}

func (r *runtime) newHelpCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "help [command...]",
		Short: "Show help for a command",
		Long:  "Show human help for the root command or one implemented command path. Use `nama schema --output json` for machine discovery.",
		Args:  cobra.ArbitraryArgs,
		RunE: func(command *cobra.Command, arguments []string) error {
			mode, err := r.resolveLocalMode()
			if err != nil {
				return r.failure(command, r.failureMode(), err)
			}
			if mode == output.JSON {
				return r.failure(command, mode, clierror.InvalidArgument(errors.New("JSON help is not supported; use nama schema --output json")))
			}
			target, remaining, err := command.Root().Find(arguments)
			if err != nil || len(remaining) != 0 {
				return r.failure(command, mode, clierror.InvalidArgument(errors.New("unknown help command")))
			}
			return target.Help()
		},
	}
	surface.SetArguments(command, surface.Argument{
		Name:        "command",
		Type:        "string",
		Required:    false,
		Variadic:    true,
		Description: "Implemented command path to describe",
	})
	return command
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

func (r *runtime) listProviderTypes(command *cobra.Command, pageSize uint32, pageToken string) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.ListProviderTypes(
			command.Context(),
			app.ListProviderTypesInput{
				Profile:   state.resolved.Profile,
				Server:    state.resolved.Server,
				PageSize:  pageSize,
				PageToken: pageToken,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}
func (r *runtime) listProviderInstances(command *cobra.Command, pageSize uint32, pageToken string) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.ListProviderInstances(
			command.Context(),
			app.ListProviderInstancesInput{
				Profile:   state.resolved.Profile,
				Server:    state.resolved.Server,
				PageSize:  pageSize,
				PageToken: pageToken,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) getProviderInstance(command *cobra.Command, providerInstanceID string) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.GetProviderInstance(
			command.Context(),
			app.GetProviderInstanceInput{
				Profile:            state.resolved.Profile,
				ProviderInstanceID: providerInstanceID,
				Server:             state.resolved.Server,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) createProviderInstance(
	command *cobra.Command,
	input providercommand.CreateInstanceInput,
) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		configuration, err := readProviderConfiguration(command, input.ConfigurationPath)
		if err != nil {
			return nil, clierror.InvalidArgument(err)
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.CreateProviderInstance(
			command.Context(),
			app.CreateProviderInstanceInput{
				Profile:        state.resolved.Profile,
				Server:         state.resolved.Server,
				OperationID:    input.OperationID,
				ProviderTypeID: input.ProviderTypeID,
				DisplayName:    input.DisplayName,
				Configuration:  configuration,
				Enabled:        input.Enabled,
				SyncPriority:   input.SyncPriority,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) updateProviderInstance(
	command *cobra.Command,
	input providercommand.UpdateInstanceInput,
) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		configurationPatch := map[string]any{}
		if input.ConfigurationPatchPath != "" {
			var err error
			configurationPatch, err = readProviderConfiguration(command, input.ConfigurationPatchPath)
			if err != nil {
				return nil, clierror.InvalidArgument(err)
			}
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.UpdateProviderInstance(
			command.Context(),
			app.UpdateProviderInstanceInput{
				Profile:                  state.resolved.Profile,
				Server:                   state.resolved.Server,
				OperationID:              input.OperationID,
				ProviderInstanceID:       input.ProviderInstanceID,
				ExpectedRevision:         input.ExpectedRevision,
				ConfigurationPatch:       configurationPatch,
				ClearConfigurationFields: input.ClearConfigurationFields,
				DisplayName:              input.DisplayName,
				Enabled:                  input.Enabled,
				SyncPriority:             input.SyncPriority,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) deleteProviderInstance(
	command *cobra.Command,
	input providercommand.DeleteInstanceInput,
) error {
	return r.execute(command, true, func(state commandState) (any, error) {
		if err := r.requireProfile(command, state); err != nil {
			return nil, err
		}
		if err := r.confirmProviderDeletion(command, state, input); err != nil {
			return nil, err
		}
		providerClient, err := r.providerClient(state)
		if err != nil {
			return nil, err
		}
		result, err := app.DeleteProviderInstance(
			command.Context(),
			app.DeleteProviderInstanceInput{
				Profile:            state.resolved.Profile,
				Server:             state.resolved.Server,
				OperationID:        input.OperationID,
				ProviderInstanceID: input.ProviderInstanceID,
				ExpectedRevision:   input.ExpectedRevision,
			},
			providerClient,
			r.dependencies.Credentials,
		)
		if err != nil {
			return nil, classifyLocalError(err)
		}
		return result, nil
	})
}

func (r *runtime) confirmProviderDeletion(
	command *cobra.Command,
	state commandState,
	input providercommand.DeleteInstanceInput,
) error {
	if input.Yes {
		return nil
	}
	if state.resolved.Output == config.OutputJSON || !r.dependencies.SecretInput.Terminal {
		return clierror.InvalidArgument(errors.New("--yes is required for non-interactive provider-instance deletion"))
	}
	if _, err := io.WriteString(
		command.ErrOrStderr(),
		"Permanently delete provider instance "+input.ProviderInstanceID+"? [y/N] ",
	); err != nil {
		return clierror.Unexpected(err)
	}
	answer, err := bufio.NewReader(command.InOrStdin()).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return clierror.Unexpected(err)
	}
	confirmed := strings.EqualFold(strings.TrimSpace(answer), "y") ||
		strings.EqualFold(strings.TrimSpace(answer), "yes")
	if !confirmed {
		return clierror.New(clierror.CodeRequestCancelled, errors.New("provider-instance deletion was not confirmed"))
	}
	return nil
}

func readProviderConfiguration(command *cobra.Command, path string) (map[string]any, error) {
	var reader io.Reader = command.InOrStdin()
	var file *os.File
	if path != "-" {
		opened, err := os.Open(path)
		if err != nil {
			return nil, errors.New("configuration could not be read")
		}
		file = opened
		reader = opened
		defer file.Close()
	}
	decoder := json.NewDecoder(reader)
	var configuration map[string]any
	if err := decoder.Decode(&configuration); err != nil || configuration == nil {
		return nil, errors.New("configuration must be one JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("configuration must contain exactly one JSON object")
	}
	return configuration, nil
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

func (r *runtime) providerClient(state commandState) (apiv1.ProviderServiceClient, error) {
	if r.dependencies.ProviderClient != nil {
		return r.dependencies.ProviderClient, nil
	}
	if r.dependencies.HTTPClient == nil {
		return nil, clierror.Unexpected(errors.New("HTTP client is required"))
	}
	clients, err := api.NewClients(r.dependencies.HTTPClient, state.resolved.Server, "")
	if err != nil {
		return nil, clierror.Unexpected(err)
	}
	return clients.Provider, nil
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

func (r *runtime) resolveLocalMode() (output.Mode, error) {
	if value, ok := explicitOutputValue(r.dependencies.RawArgs); ok {
		if mode, valid := parseOutputMode(value); valid {
			return mode, nil
		}
		return "", clierror.InvalidArgument(errors.New("output must be human or json"))
	}
	if r.output != "" {
		if mode, ok := parseOutputMode(r.output); ok {
			return mode, nil
		}
		return "", clierror.InvalidArgument(errors.New("output must be human or json"))
	}
	if value := r.getenv("NAMA_OUTPUT"); value != "" {
		if mode, ok := parseOutputMode(value); ok {
			return mode, nil
		}
		return "", clierror.InvalidConfiguration(errors.New("NAMA_OUTPUT must be human or json"))
	}
	value, err := r.store.Load()
	if err != nil {
		return output.Human, nil
	}
	if mode, ok := parseOutputMode(string(value.PreferredOutput)); ok {
		return mode, nil
	}
	return output.Human, nil
}

// ExplicitOutputMode reports the valid output mode explicitly requested in raw arguments.
func ExplicitOutputMode(arguments []string) (output.Mode, bool) {
	value, ok := explicitOutputValue(arguments)
	if !ok {
		return "", false
	}
	return parseOutputMode(value)
}

func explicitOutputValue(arguments []string) (string, bool) {
	mode := ""
	found := false
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
				found = true
			}
		case strings.HasPrefix(argument, "--output="):
			mode = strings.TrimPrefix(argument, "--output=")
			found = true
		case argument == "--server", argument == "--profile", argument == "--email", argument == "--display-name":
			if index+1 < len(arguments) {
				index++
			}
		}
	}
	return mode, found
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
