// Package completion constructs the shell-completion command.
package completion

import (
	"errors"
	"io"

	"github.com/electather/nama/apps/cli/internal/surface"
	"github.com/spf13/cobra"
)

type shell struct {
	name        string
	description string
	generate    func(*cobra.Command, io.Writer) error
}

var supportedShells = []shell{
	{
		name:        "bash",
		description: "Generate Bash completion",
		generate: func(root *cobra.Command, writer io.Writer) error {
			return root.GenBashCompletionV2(writer, true)
		},
	},
	{
		name:        "zsh",
		description: "Generate Zsh completion",
		generate: func(root *cobra.Command, writer io.Writer) error {
			return root.GenZshCompletion(writer)
		},
	},
	{
		name:        "fish",
		description: "Generate Fish completion",
		generate: func(root *cobra.Command, writer io.Writer) error {
			return root.GenFishCompletion(writer, true)
		},
	},
	{
		name:        "powershell",
		description: "Generate PowerShell completion",
		generate: func(root *cobra.Command, writer io.Writer) error {
			return root.GenPowerShellCompletionWithDesc(writer)
		},
	},
}

// Generate writes the named shell's completion script with descriptions.
func Generate(root *cobra.Command, name string, writer io.Writer) error {
	value, ok := findShell(name)
	if !ok {
		return errors.New("unsupported shell")
	}
	return value.generate(root, writer)
}

// Handler binds completion generation to the CLI composition root.
type Handler struct {
	Run              func(*cobra.Command, string) error
	InvalidArguments func(*cobra.Command, error) error
}

// NewCommand constructs the shell-completion command.
func NewCommand(handler Handler) *cobra.Command {
	command := &cobra.Command{
		Use:                   "completion <shell>",
		Short:                 "Generate a shell completion script",
		Long:                  "Generate a completion script for Bash, Zsh, Fish, or PowerShell without installing or changing shell configuration.",
		Example:               "  nama completion bash > /etc/bash_completion.d/nama\n  nama completion zsh > \"${fpath[1]}/_nama\"\n  nama completion fish > ~/.config/fish/completions/nama.fish\n  nama completion powershell > nama.ps1",
		DisableFlagsInUseLine: true,
		ValidArgs:             shellCompletions(),
		Args: func(command *cobra.Command, arguments []string) error {
			if len(arguments) != 1 {
				return handler.InvalidArguments(command, errors.New("exactly one shell is required"))
			}
			if _, ok := findShell(arguments[0]); !ok {
				return handler.InvalidArguments(command, errors.New("unsupported shell"))
			}
			return nil
		},
		RunE: func(command *cobra.Command, arguments []string) error {
			return handler.Run(command, arguments[0])
		},
	}
	surface.SetArguments(command, surface.Argument{
		Name:          "shell",
		Type:          "string",
		Required:      true,
		Description:   "Shell whose completion script is generated",
		AllowedValues: shellNames(),
	})
	return command
}

func findShell(name string) (shell, bool) {
	for _, value := range supportedShells {
		if value.name == name {
			return value, true
		}
	}
	return shell{}, false
}

func shellNames() []string {
	names := make([]string, 0, len(supportedShells))
	for _, value := range supportedShells {
		names = append(names, value.name)
	}
	return names
}

func shellCompletions() []cobra.Completion {
	values := make([]cobra.Completion, 0, len(supportedShells))
	for _, value := range supportedShells {
		values = append(values, cobra.CompletionWithDesc(value.name, value.description))
	}
	return values
}
