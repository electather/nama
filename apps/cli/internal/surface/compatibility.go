package surface

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
)

// CheckCompatibility rejects changes that would break existing CLI invocations.
func CheckCompatibility(baseline, current Schema) error {
	if current.SchemaVersion != baseline.SchemaVersion {
		return fmt.Errorf("schema version changed from %d to %d", baseline.SchemaVersion, current.SchemaVersion)
	}

	currentCommands, err := commandsByPath(current.Commands)
	if err != nil {
		return err
	}
	for _, baselineCommand := range baseline.Commands {
		path := strings.Join(baselineCommand.Path, " ")
		currentCommand, ok := currentCommands[path]
		if !ok {
			return fmt.Errorf("command %s was removed or renamed", path)
		}
		if err := checkArguments(path, baselineCommand.Arguments, currentCommand.Arguments); err != nil {
			return err
		}
		if err := checkFlags(path, baselineCommand.Flags, currentCommand.Flags); err != nil {
			return err
		}
		if err := checkInputs(path, baselineCommand.Inputs, currentCommand.Inputs); err != nil {
			return err
		}
	}
	return checkExitCodes(baseline.ExitCodes, current.ExitCodes)
}

// CheckJSONCompatibility rejects removal or JSON-type changes to existing schema fields.
func CheckJSONCompatibility(baselineJSON, currentJSON []byte) error {
	baseline, err := decodeJSONObject(baselineJSON)
	if err != nil {
		return fmt.Errorf("decode baseline schema: %w", err)
	}
	current, err := decodeJSONObject(currentJSON)
	if err != nil {
		return fmt.Errorf("decode current schema: %w", err)
	}
	if err := checkObjectShape("schema", baseline, current); err != nil {
		return err
	}

	baselineCommands, err := jsonRecordsByIdentity(baseline, "commands", jsonCommandIdentity)
	if err != nil {
		return err
	}
	currentCommands, err := jsonRecordsByIdentity(current, "commands", jsonCommandIdentity)
	if err != nil {
		return err
	}
	for identity, baselineCommand := range baselineCommands {
		currentCommand, ok := currentCommands[identity]
		if !ok {
			return fmt.Errorf("command %s was removed or renamed", identity)
		}
		commandContext := "command " + identity
		if err := checkObjectShape(commandContext, baselineCommand, currentCommand); err != nil {
			return err
		}
		for _, field := range []string{"arguments", "flags", "inputs"} {
			if err := checkNamedRecordShapes(commandContext, field, baselineCommand, currentCommand); err != nil {
				return err
			}
		}
	}
	return checkExitRecordShapes(baseline, current)
}

func commandsByPath(commands []Command) (map[string]Command, error) {
	result := make(map[string]Command, len(commands))
	for _, command := range commands {
		path := strings.Join(command.Path, " ")
		if _, exists := result[path]; exists {
			return nil, fmt.Errorf("command %s is duplicated", path)
		}
		result[path] = command
	}
	return result, nil
}

func checkArguments(path string, baseline, current []Argument) error {
	if len(current) < len(baseline) {
		return fmt.Errorf("command %s argument %s was removed", path, baseline[len(current)].Name)
	}
	for index, baselineArgument := range baseline {
		currentArgument := current[index]
		context := fmt.Sprintf("command %s argument %s", path, baselineArgument.Name)
		if currentArgument.Name != baselineArgument.Name {
			return fmt.Errorf("%s was removed, renamed, or reordered", context)
		}
		if currentArgument.Type != baselineArgument.Type {
			return fmt.Errorf("%s type changed from %s to %s", context, baselineArgument.Type, currentArgument.Type)
		}
		if !baselineArgument.Required && currentArgument.Required {
			return fmt.Errorf("%s became required", context)
		}
		if currentArgument.Variadic != baselineArgument.Variadic {
			return fmt.Errorf("%s variadic behavior changed", context)
		}
		if missing := removedValues(baselineArgument.AllowedValues, currentArgument.AllowedValues); len(missing) != 0 {
			return fmt.Errorf("%s allowed value %q was removed", context, missing[0])
		}
	}
	for _, argument := range current[len(baseline):] {
		if argument.Required {
			return fmt.Errorf("command %s new argument %s is required", path, argument.Name)
		}
	}
	return nil
}

func checkFlags(path string, baseline, current []Flag) error {
	currentFlags, err := flagsByName(current)
	if err != nil {
		return fmt.Errorf("command %s: %w", path, err)
	}
	baselineNames := make(map[string]struct{}, len(baseline))
	for _, baselineFlag := range baseline {
		baselineNames[baselineFlag.Name] = struct{}{}
		context := fmt.Sprintf("command %s flag %s", path, baselineFlag.Name)
		currentFlag, ok := currentFlags[baselineFlag.Name]
		if !ok {
			return fmt.Errorf("%s was removed or renamed", context)
		}
		if currentFlag.Type != baselineFlag.Type {
			return fmt.Errorf("%s type changed from %s to %s", context, baselineFlag.Type, currentFlag.Type)
		}
		if !baselineFlag.Required && currentFlag.Required {
			return fmt.Errorf("%s became required", context)
		}
		if currentFlag.Inherited != baselineFlag.Inherited {
			return fmt.Errorf("%s inheritance changed", context)
		}
		if currentFlag.Environment != baselineFlag.Environment {
			return fmt.Errorf("%s environment changed from %q to %q", context, baselineFlag.Environment, currentFlag.Environment)
		}
		if currentFlag.Default != baselineFlag.Default {
			return fmt.Errorf("%s default changed from %q to %q", context, baselineFlag.Default, currentFlag.Default)
		}
		if missing := removedValues(baselineFlag.AllowedValues, currentFlag.AllowedValues); len(missing) != 0 {
			return fmt.Errorf("%s allowed value %q was removed", context, missing[0])
		}
	}
	for _, flag := range current {
		if _, existed := baselineNames[flag.Name]; !existed && flag.Required {
			return fmt.Errorf("command %s new flag %s is required", path, flag.Name)
		}
	}
	return nil
}

func flagsByName(flags []Flag) (map[string]Flag, error) {
	result := make(map[string]Flag, len(flags))
	for _, flag := range flags {
		if _, exists := result[flag.Name]; exists {
			return nil, fmt.Errorf("flag %s is duplicated", flag.Name)
		}
		result[flag.Name] = flag
	}
	return result, nil
}

func checkInputs(path string, baseline, current []Input) error {
	currentInputs := make(map[string]Input, len(current))
	for _, input := range current {
		if _, exists := currentInputs[input.Name]; exists {
			return fmt.Errorf("command %s input %s is duplicated", path, input.Name)
		}
		currentInputs[input.Name] = input
	}
	baselineNames := make(map[string]struct{}, len(baseline))
	for _, baselineInput := range baseline {
		baselineNames[baselineInput.Name] = struct{}{}
		context := fmt.Sprintf("command %s input %s", path, baselineInput.Name)
		currentInput, ok := currentInputs[baselineInput.Name]
		if !ok {
			return fmt.Errorf("%s was removed or renamed", context)
		}
		if currentInput.Type != baselineInput.Type {
			return fmt.Errorf("%s type changed from %s to %s", context, baselineInput.Type, currentInput.Type)
		}
		if !baselineInput.Required && currentInput.Required {
			return fmt.Errorf("%s became required", context)
		}
		if currentInput.Secret != baselineInput.Secret {
			return fmt.Errorf("%s secret classification changed", context)
		}
		if !slices.Equal(currentInput.Sources, baselineInput.Sources) {
			return fmt.Errorf("%s sources changed", context)
		}
	}
	for _, input := range current {
		if _, existed := baselineNames[input.Name]; !existed && input.Required {
			return fmt.Errorf("command %s new input %s is required", path, input.Name)
		}
	}
	return nil
}

func checkExitCodes(baseline, current []ExitCode) error {
	currentByCode := make(map[int]ExitCode, len(current))
	for _, exit := range current {
		currentByCode[exit.Code] = exit
	}
	for _, baselineExit := range baseline {
		currentExit, ok := currentByCode[baselineExit.Code]
		if !ok {
			return fmt.Errorf("exit code %d was removed", baselineExit.Code)
		}
		if currentExit.Meaning != baselineExit.Meaning {
			return fmt.Errorf("exit code %d meaning changed", baselineExit.Code)
		}
	}
	baselineMappings, err := errorExitMappings(baseline)
	if err != nil {
		return err
	}
	currentMappings, err := errorExitMappings(current)
	if err != nil {
		return err
	}
	for code, baselineExit := range baselineMappings {
		if currentExit, ok := currentMappings[code]; !ok || currentExit != baselineExit {
			return fmt.Errorf("error %s changed from exit code %d", code, baselineExit)
		}
	}
	return nil
}

func errorExitMappings(exits []ExitCode) (map[string]int, error) {
	result := make(map[string]int)
	for _, exit := range exits {
		for _, code := range exit.ErrorCodes {
			if previous, exists := result[code]; exists {
				return nil, fmt.Errorf("error %s is mapped to exit codes %d and %d", code, previous, exit.Code)
			}
			result[code] = exit.Code
		}
	}
	return result, nil
}

func removedValues(baseline, current []string) []string {
	currentValues := make(map[string]struct{}, len(current))
	for _, value := range current {
		currentValues[value] = struct{}{}
	}
	missing := make([]string, 0)
	for _, value := range baseline {
		if _, ok := currentValues[value]; !ok {
			missing = append(missing, value)
		}
	}
	return missing
}

func decodeJSONObject(value []byte) (map[string]any, error) {
	var result map[string]any
	if err := json.Unmarshal(value, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func checkObjectShape(context string, baseline, current map[string]any) error {
	for field, baselineValue := range baseline {
		currentValue, ok := current[field]
		if !ok {
			return fmt.Errorf("%s field %s was removed", context, field)
		}
		if jsonKind(currentValue) != jsonKind(baselineValue) {
			return fmt.Errorf("%s field %s changed type from %s to %s", context, field, jsonKind(baselineValue), jsonKind(currentValue))
		}
	}
	return nil
}

func jsonKind(value any) string {
	if value == nil {
		return "null"
	}
	typeOf := reflect.TypeOf(value)
	switch typeOf.Kind() {
	case reflect.Map:
		return "object"
	case reflect.Slice:
		return "array"
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Float32, reflect.Float64, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "number"
	default:
		return typeOf.String()
	}
}

func jsonRecordsByIdentity(parent map[string]any, field string, identity func(map[string]any) (string, error)) (map[string]map[string]any, error) {
	values, ok := parent[field].([]any)
	if !ok {
		return nil, fmt.Errorf("schema field %s is not an array", field)
	}
	result := make(map[string]map[string]any, len(values))
	for _, value := range values {
		record, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema field %s contains a non-object", field)
		}
		key, err := identity(record)
		if err != nil {
			return nil, err
		}
		result[key] = record
	}
	return result, nil
}

func jsonCommandIdentity(command map[string]any) (string, error) {
	values, ok := command["path"].([]any)
	if !ok {
		return "", fmt.Errorf("command path is not an array")
	}
	path := make([]string, 0, len(values))
	for _, value := range values {
		name, ok := value.(string)
		if !ok {
			return "", fmt.Errorf("command path contains a non-string")
		}
		path = append(path, name)
	}
	return strings.Join(path, " "), nil
}

func checkNamedRecordShapes(context, field string, baseline, current map[string]any) error {
	identity := func(record map[string]any) (string, error) {
		name, ok := record["name"].(string)
		if !ok {
			return "", fmt.Errorf("%s %s name is not a string", context, field)
		}
		return name, nil
	}
	baselineRecords, err := jsonRecordsByIdentity(baseline, field, identity)
	if err != nil {
		return err
	}
	currentRecords, err := jsonRecordsByIdentity(current, field, identity)
	if err != nil {
		return err
	}
	kind := strings.TrimSuffix(field, "s")
	for name, baselineRecord := range baselineRecords {
		currentRecord, ok := currentRecords[name]
		if !ok {
			return fmt.Errorf("%s %s %s was removed", context, kind, name)
		}
		recordContext := fmt.Sprintf("%s %s %s", context, kind, name)
		if err := checkObjectShape(recordContext, baselineRecord, currentRecord); err != nil {
			return err
		}
		if field == "inputs" {
			if err := checkSourceShapes(recordContext, baselineRecord, currentRecord); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkSourceShapes(context string, baseline, current map[string]any) error {
	baselineSources, ok := baseline["sources"].([]any)
	if !ok {
		return fmt.Errorf("%s field sources is not an array", context)
	}
	currentSources, ok := current["sources"].([]any)
	if !ok || len(currentSources) < len(baselineSources) {
		return fmt.Errorf("%s field sources changed", context)
	}
	for index, baselineValue := range baselineSources {
		baselineSource, baselineOK := baselineValue.(map[string]any)
		currentSource, currentOK := currentSources[index].(map[string]any)
		if !baselineOK || !currentOK {
			return fmt.Errorf("%s source %d is not an object", context, index)
		}
		if err := checkObjectShape(fmt.Sprintf("%s source %d", context, index), baselineSource, currentSource); err != nil {
			return err
		}
	}
	return nil
}

func checkExitRecordShapes(baseline, current map[string]any) error {
	identity := func(record map[string]any) (string, error) {
		code, ok := record["code"].(float64)
		if !ok {
			return "", fmt.Errorf("exit code is not a number")
		}
		return fmt.Sprintf("%g", code), nil
	}
	baselineRecords, err := jsonRecordsByIdentity(baseline, "exit_codes", identity)
	if err != nil {
		return err
	}
	currentRecords, err := jsonRecordsByIdentity(current, "exit_codes", identity)
	if err != nil {
		return err
	}
	for code, baselineRecord := range baselineRecords {
		currentRecord, ok := currentRecords[code]
		if !ok {
			return fmt.Errorf("exit code %s was removed", code)
		}
		if err := checkObjectShape("exit code "+code, baselineRecord, currentRecord); err != nil {
			return err
		}
	}
	return nil
}
