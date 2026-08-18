// Package surface extracts Nama's public process contract from the Cobra tree.
package surface

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const (
	argumentsAnnotation = "nama.arguments"
	inputsAnnotation    = "nama.inputs"
	environmentKey      = "nama.environment"
	allowedValuesKey    = "nama.allowed-values"
	requiredKey         = "nama.required"
	defaultKey          = "nama.default"
)

// Schema is version 1 of Nama's machine-readable invocation contract.
type Schema struct {
	SchemaVersion int        `json:"schema_version"`
	Commands      []Command  `json:"commands"`
	ExitCodes     []ExitCode `json:"exit_codes"`
}

// Command describes one visible command path.
type Command struct {
	Path        []string   `json:"path"`
	Summary     string     `json:"summary"`
	Description string     `json:"description"`
	Arguments   []Argument `json:"arguments"`
	Flags       []Flag     `json:"flags"`
	Inputs      []Input    `json:"inputs"`
}

// Argument describes one positional command argument.
type Argument struct {
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	Required      bool     `json:"required"`
	Variadic      bool     `json:"variadic"`
	Description   string   `json:"description"`
	AllowedValues []string `json:"allowed_values"`
}

// Flag describes one effective local or inherited flag.
type Flag struct {
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	Required      bool     `json:"required"`
	Inherited     bool     `json:"inherited"`
	Description   string   `json:"description"`
	Environment   string   `json:"environment"`
	Default       string   `json:"default"`
	AllowedValues []string `json:"allowed_values"`
}

// Input describes a conditional non-flag input.
type Input struct {
	Name        string        `json:"name"`
	Type        string        `json:"type"`
	Required    bool          `json:"required"`
	Secret      bool          `json:"secret"`
	Description string        `json:"description"`
	Sources     []InputSource `json:"sources"`
}

// InputSourceKind identifies how a conditional input is supplied.
type InputSourceKind string

const (
	InputSourceKindHiddenPrompt          InputSourceKind = "hidden_prompt"
	InputSourceKindStdinLine             InputSourceKind = "stdin_line"
	InputSourceKindEnvironment           InputSourceKind = "environment"
	InputSourceKindNativeCredentialStore InputSourceKind = "native_credential_store"
	InputSourceKindRejected              InputSourceKind = "rejected"
)

// InputSourceCondition identifies when an input source applies.
type InputSourceCondition string

const (
	InputSourceConditionHumanTerminal  InputSourceCondition = "human_terminal"
	InputSourceConditionNonterminal    InputSourceCondition = "nonterminal"
	InputSourceConditionJSONTerminal   InputSourceCondition = "json_terminal"
	InputSourceConditionAlways         InputSourceCondition = "always"
	InputSourceConditionNAMATokenUnset InputSourceCondition = "NAMA_TOKEN_unset"
)

// InputSource describes one safe source or rejected terminal condition.
type InputSource struct {
	Kind      InputSourceKind      `json:"kind"`
	Name      string               `json:"name"`
	Condition InputSourceCondition `json:"condition"`
}

// ExitCode publishes one process exit meaning and its stable error mappings.
type ExitCode struct {
	Code       int      `json:"code"`
	Meaning    string   `json:"meaning"`
	ErrorCodes []string `json:"error_codes"`
}

// FlagMetadata adds contract details that pflag does not model.
type FlagMetadata struct {
	Required      bool
	Environment   string
	Default       string
	AllowedValues []string
}

// SetArguments attaches ordered positional-argument metadata to a command.
func SetArguments(command *cobra.Command, arguments ...Argument) {
	setCommandAnnotation(command, argumentsAnnotation, arguments)
}

// SetInputs attaches ordered conditional-input metadata to a command.
func SetInputs(command *cobra.Command, inputs ...Input) {
	setCommandAnnotation(command, inputsAnnotation, inputs)
}

// PasswordInput returns the shared password-input contract with command-specific copy.
func PasswordInput(description string) Input {
	return Input{
		Name:        "password",
		Type:        "string",
		Required:    true,
		Secret:      true,
		Description: description,
		Sources: []InputSource{
			{
				Kind:      InputSourceKindHiddenPrompt,
				Name:      "Password",
				Condition: InputSourceConditionHumanTerminal,
			},
			{
				Kind:      InputSourceKindStdinLine,
				Name:      "stdin",
				Condition: InputSourceConditionNonterminal,
			},
			{
				Kind:      InputSourceKindRejected,
				Name:      "terminal_stdin",
				Condition: InputSourceConditionJSONTerminal,
			},
		},
	}
}

// SetFlag attaches public metadata to an existing local or persistent flag.
func SetFlag(command *cobra.Command, name string, metadata FlagMetadata) {
	flag := command.Flags().Lookup(name)
	if flag == nil {
		flag = command.PersistentFlags().Lookup(name)
	}
	if flag == nil {
		panic(fmt.Sprintf("annotate missing flag %q", name))
	}
	setFlagAnnotation(flag, environmentKey, metadata.Environment)
	setFlagAnnotation(flag, allowedValuesKey, metadata.AllowedValues...)
	setFlagAnnotation(flag, requiredKey, strconv.FormatBool(metadata.Required))
	if metadata.Default != "" {
		setFlagAnnotation(flag, defaultKey, metadata.Default)
	}
}

// Extract walks the visible Cobra tree and returns the canonical schema.
func Extract(root *cobra.Command) Schema {
	root.InitDefaultHelpCmd()
	commands := make([]Command, 0)
	walkCommands(root, &commands)
	slices.SortFunc(commands, func(left, right Command) int {
		return strings.Compare(strings.Join(left.Path, "\x00"), strings.Join(right.Path, "\x00"))
	})
	return Schema{
		SchemaVersion: 1,
		Commands:      commands,
		ExitCodes:     exitCodes(),
	}
}

// Inventory renders the compact, evolvable human schema view.
func Inventory(schema Schema) string {
	var result strings.Builder
	for _, command := range schema.Commands {
		fmt.Fprintf(&result, "%s\t%s\n", strings.Join(command.Path, " "), command.Summary)
	}
	return result.String()
}

func walkCommands(command *cobra.Command, result *[]Command) {
	if command.Hidden {
		return
	}
	command.InitDefaultHelpFlag()
	*result = append(*result, extractCommand(command))
	for _, child := range command.Commands() {
		walkCommands(child, result)
	}
}

func extractCommand(command *cobra.Command) Command {
	description := command.Long
	if description == "" {
		description = command.Short
	}
	arguments := commandArguments(command)
	inputs := commandInputs(command)
	return Command{
		Path:        commandPath(command),
		Summary:     command.Short,
		Description: description,
		Arguments:   arguments,
		Flags:       commandFlags(command),
		Inputs:      inputs,
	}
}

func commandPath(command *cobra.Command) []string {
	path := make([]string, 0, 4)
	for current := command; current != nil; current = current.Parent() {
		path = append(path, current.Name())
	}
	slices.Reverse(path)
	return path
}

func commandArguments(command *cobra.Command) []Argument {
	arguments := []Argument{}
	readCommandAnnotation(command, argumentsAnnotation, &arguments)
	for index := range arguments {
		arguments[index].AllowedValues = sortedClone(arguments[index].AllowedValues)
	}
	return arguments
}

func commandInputs(command *cobra.Command) []Input {
	inputs := []Input{}
	readCommandAnnotation(command, inputsAnnotation, &inputs)
	return inputs
}

func commandFlags(command *cobra.Command) []Flag {
	flags := make([]Flag, 0)
	inherited := command.InheritedFlags()
	command.Flags().VisitAll(func(flag *pflag.Flag) {
		if flag.Hidden {
			return
		}
		defaultValue := flag.DefValue
		if value, ok := firstFlagAnnotation(flag, defaultKey); ok {
			defaultValue = value
		}
		required, _ := strconv.ParseBool(firstFlagAnnotationValue(flag, requiredKey))
		flags = append(flags, Flag{
			Name:          flag.Name,
			Type:          flag.Value.Type(),
			Required:      required,
			Inherited:     inherited.Lookup(flag.Name) != nil,
			Description:   flag.Usage,
			Environment:   firstFlagAnnotationValue(flag, environmentKey),
			Default:       defaultValue,
			AllowedValues: sortedClone(flag.Annotations[allowedValuesKey]),
		})
	})
	slices.SortFunc(flags, func(left, right Flag) int {
		return strings.Compare(left.Name, right.Name)
	})
	return flags
}

func exitCodes() []ExitCode {
	result := []ExitCode{
		{Code: 0, Meaning: "success", ErrorCodes: []string{}},
		{Code: 1, Meaning: "unexpected failure or cancellation", ErrorCodes: []string{}},
		{Code: 2, Meaning: "invalid arguments or configuration", ErrorCodes: []string{}},
		{Code: 3, Meaning: "authentication failure", ErrorCodes: []string{}},
		{Code: 4, Meaning: "permission denied", ErrorCodes: []string{}},
		{Code: 5, Meaning: "resource not found", ErrorCodes: []string{}},
		{Code: 6, Meaning: "conflict or invalid state", ErrorCodes: []string{}},
		{Code: 7, Meaning: "network or API unavailable, rate limited, or resource exhausted", ErrorCodes: []string{}},
	}
	for _, code := range clierror.Codes() {
		exit := clierror.New(code, nil).ExitCode()
		result[exit].ErrorCodes = append(result[exit].ErrorCodes, code)
	}
	return result
}

func setCommandAnnotation[T any](command *cobra.Command, key string, value T) {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("encode %s: %v", key, err))
	}
	if command.Annotations == nil {
		command.Annotations = make(map[string]string)
	}
	command.Annotations[key] = string(encoded)
}

func readCommandAnnotation(command *cobra.Command, key string, target any) {
	if command.Annotations == nil || command.Annotations[key] == "" {
		return
	}
	if err := json.Unmarshal([]byte(command.Annotations[key]), target); err != nil {
		panic(fmt.Sprintf("decode %s: %v", key, err))
	}
}

func setFlagAnnotation(flag *pflag.Flag, key string, values ...string) {
	if flag.Annotations == nil {
		flag.Annotations = make(map[string][]string)
	}
	flag.Annotations[key] = slices.Clone(values)
}

func firstFlagAnnotation(flag *pflag.Flag, key string) (string, bool) {
	values := flag.Annotations[key]
	if len(values) == 0 {
		return "", false
	}
	return values[0], true
}

func firstFlagAnnotationValue(flag *pflag.Flag, key string) string {
	value, _ := firstFlagAnnotation(flag, key)
	return value
}

func sortedClone(values []string) []string {
	result := slices.Clone(values)
	if result == nil {
		result = []string{}
	}
	slices.Sort(result)
	return result
}
