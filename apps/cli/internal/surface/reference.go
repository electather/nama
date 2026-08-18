package surface

import (
	"fmt"
	"strings"
)

// RenderReference renders deterministic Markdown from the canonical schema.
func RenderReference(schema Schema) []byte {
	var result strings.Builder
	result.WriteString("# Nama CLI reference\n\n")
	fmt.Fprintf(&result, "Machine schema version: `%d`. Human formatting and descriptions may evolve; automation should use `nama schema --output json`.\n\n", schema.SchemaVersion)
	for _, command := range schema.Commands {
		fmt.Fprintf(&result, "## `%s`\n\n", strings.Join(command.Path, " "))
		fmt.Fprintf(&result, "%s\n\n", command.Summary)
		if command.Description != "" && command.Description != command.Summary {
			fmt.Fprintf(&result, "%s\n\n", command.Description)
		}
		renderArguments(&result, command.Arguments)
		renderFlags(&result, command.Flags)
		renderInputs(&result, command.Inputs)
	}
	result.WriteString("## Exit codes\n\n")
	result.WriteString("| Code | Meaning | Stable error codes |\n")
	result.WriteString("| ---: | --- | --- |\n")
	for _, exit := range schema.ExitCodes {
		codes := "—"
		if len(exit.ErrorCodes) != 0 {
			quoted := make([]string, 0, len(exit.ErrorCodes))
			for _, code := range exit.ErrorCodes {
				quoted = append(quoted, "`"+code+"`")
			}
			codes = strings.Join(quoted, ", ")
		}
		fmt.Fprintf(&result, "| %d | %s | %s |\n", exit.Code, markdownCell(exit.Meaning), codes)
	}
	return []byte(result.String())
}

func renderArguments(result *strings.Builder, arguments []Argument) {
	result.WriteString("### Arguments\n\n")
	if len(arguments) == 0 {
		result.WriteString("None.\n\n")
		return
	}
	result.WriteString("| Name | Type | Required | Variadic | Allowed values | Description |\n")
	result.WriteString("| --- | --- | --- | --- | --- | --- |\n")
	for _, argument := range arguments {
		fmt.Fprintf(result, "| `%s` | `%s` | %s | %s | %s | %s |\n",
			argument.Name,
			argument.Type,
			boolWord(argument.Required),
			boolWord(argument.Variadic),
			markdownValues(argument.AllowedValues),
			markdownCell(argument.Description),
		)
	}
	result.WriteByte('\n')
}

func renderFlags(result *strings.Builder, flags []Flag) {
	result.WriteString("### Effective flags\n\n")
	if len(flags) == 0 {
		result.WriteString("None.\n\n")
		return
	}
	result.WriteString("| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |\n")
	result.WriteString("| --- | --- | --- | --- | --- | --- | --- | --- |\n")
	for _, flag := range flags {
		scope := "local"
		if flag.Inherited {
			scope = "inherited"
		}
		environment := "—"
		if flag.Environment != "" {
			environment = "`" + flag.Environment + "`"
		}
		fmt.Fprintf(result, "| `--%s` | `%s` | %s | %s | %s | `%s` | %s | %s |\n",
			flag.Name,
			flag.Type,
			boolWord(flag.Required),
			scope,
			environment,
			markdownCell(flag.Default),
			markdownValues(flag.AllowedValues),
			markdownCell(flag.Description),
		)
	}
	result.WriteByte('\n')
}

func renderInputs(result *strings.Builder, inputs []Input) {
	result.WriteString("### Conditional inputs\n\n")
	if len(inputs) == 0 {
		result.WriteString("None.\n\n")
		return
	}
	result.WriteString("| Name | Type | Required | Secret | Description |\n")
	result.WriteString("| --- | --- | --- | --- | --- |\n")
	for _, input := range inputs {
		fmt.Fprintf(result, "| `%s` | `%s` | %s | %s | %s |\n",
			input.Name,
			input.Type,
			boolWord(input.Required),
			boolWord(input.Secret),
			markdownCell(input.Description),
		)
	}
	result.WriteString("\nSources:\n\n")
	for _, input := range inputs {
		fmt.Fprintf(result, "- `%s`:\n", input.Name)
		for _, source := range input.Sources {
			name := "—"
			if source.Name != "" {
				name = "`" + source.Name + "`"
			}
			fmt.Fprintf(result, "  - kind `%s`; source %s; condition `%s`\n", source.Kind, name, source.Condition)
		}
	}
	result.WriteByte('\n')
}

func markdownValues(values []string) string {
	if len(values) == 0 {
		return "—"
	}
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, "`"+markdownCell(value)+"`")
	}
	return strings.Join(quoted, ", ")
}

func markdownCell(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	return strings.ReplaceAll(value, "\n", "<br>")
}

func boolWord(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}
