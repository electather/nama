package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/electather/nama/apps/cli/internal/app"
	credentialauth "github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	"github.com/electather/nama/apps/cli/internal/output"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"github.com/spf13/cobra"
)

type providerConfigurationConstraints struct {
	enumValues     []any
	format         string
	hasMaximum     bool
	hasMaximumSize bool
	hasMinimum     bool
	hasMinimumSize bool
	itemEnumValues []string
	maximum        float64
	maximumSize    int
	minimum        float64
	minimumSize    int
	uniqueItems    bool
}

type providerConfigurationProperty struct {
	constraints  providerConfigurationConstraints
	defaultValue any
	description  string
	hasDefault   bool
	hasOrder     bool
	key          string
	order        float64
	required     bool
	title        string
	valueType    string
	writeOnly    bool
}

func schemaSizeConstraint(schema map[string]any, key string) (int, bool, error) {
	raw, present := schema[key]
	if !present {
		return 0, false, nil
	}
	value, valid := raw.(float64)
	if !valid || !isFinite(value) || math.Trunc(value) != value || value < 0 || value > math.MaxInt {
		return 0, false, errors.New("provider configuration schema size constraint is invalid")
	}
	return int(value), true, nil
}

func schemaNumberConstraint(schema map[string]any, key string) (float64, bool, error) {
	raw, present := schema[key]
	if !present {
		return 0, false, nil
	}
	value, valid := raw.(float64)
	if !valid || !isFinite(value) {
		return 0, false, errors.New("provider configuration schema numeric constraint is invalid")
	}
	return value, true, nil
}

func schemaEnumValues(schema map[string]any) ([]any, error) {
	raw, present := schema["enum"]
	if !present {
		return nil, nil
	}
	values, valid := raw.([]any)
	if !valid {
		return nil, errors.New("provider configuration schema enum is invalid")
	}
	return values, nil
}

func providerPropertyConstraints(
	property map[string]any,
	valueType string,
) (providerConfigurationConstraints, error) {
	enumValues, err := schemaEnumValues(property)
	if err != nil {
		return providerConfigurationConstraints{}, err
	}
	minimumSizeKey := "minLength"
	maximumSizeKey := "maxLength"
	if valueType == "array" {
		minimumSizeKey = "minItems"
		maximumSizeKey = "maxItems"
	}
	minimumSize, hasMinimumSize, err := schemaSizeConstraint(property, minimumSizeKey)
	if err != nil {
		return providerConfigurationConstraints{}, err
	}
	maximumSize, hasMaximumSize, err := schemaSizeConstraint(property, maximumSizeKey)
	if err != nil {
		return providerConfigurationConstraints{}, err
	}
	minimum, hasMinimum, err := schemaNumberConstraint(property, "minimum")
	if err != nil {
		return providerConfigurationConstraints{}, err
	}
	maximum, hasMaximum, err := schemaNumberConstraint(property, "maximum")
	if err != nil {
		return providerConfigurationConstraints{}, err
	}
	format := ""
	if rawFormat, present := property["format"]; present {
		format, _ = rawFormat.(string)
		if valueType != "string" ||
			(format != "hostname" && format != "password" && format != "uri") {
			return providerConfigurationConstraints{}, errors.New("provider configuration schema format is invalid")
		}
	}
	uniqueItems := false
	if rawUniqueItems, present := property["uniqueItems"]; present {
		var valid bool
		uniqueItems, valid = rawUniqueItems.(bool)
		if !valid || valueType != "array" {
			return providerConfigurationConstraints{}, errors.New("provider configuration schema unique-items constraint is invalid")
		}
	}
	var itemEnumValues []string
	if valueType == "array" {
		items, valid := property["items"].(map[string]any)
		if !valid || items["type"] != "string" {
			return providerConfigurationConstraints{}, errors.New("provider configuration schema array items are invalid")
		}
		itemEnums, enumErr := schemaEnumValues(items)
		if enumErr != nil {
			return providerConfigurationConstraints{}, enumErr
		}
		for _, item := range itemEnums {
			value, valid := item.(string)
			if !valid {
				return providerConfigurationConstraints{}, errors.New("provider configuration schema item enum is invalid")
			}
			itemEnumValues = append(itemEnumValues, value)
		}
	}
	return providerConfigurationConstraints{
		enumValues:     enumValues,
		format:         format,
		hasMaximum:     hasMaximum,
		hasMaximumSize: hasMaximumSize,
		hasMinimum:     hasMinimum,
		hasMinimumSize: hasMinimumSize,
		itemEnumValues: itemEnumValues,
		maximum:        maximum,
		maximumSize:    maximumSize,
		minimum:        minimum,
		minimumSize:    minimumSize,
		uniqueItems:    uniqueItems,
	}, nil
}

func providerConfigurationProperties(schema map[string]any) ([]providerConfigurationProperty, error) {
	propertiesValue, ok := schema["properties"]
	if !ok {
		return nil, clierror.Unexpected(errors.New("provider configuration schema has no properties"))
	}
	properties, ok := propertiesValue.(map[string]any)
	if !ok {
		return nil, clierror.Unexpected(errors.New("provider configuration schema properties are invalid"))
	}
	required := make(map[string]struct{})
	if requiredValue, present := schema["required"]; present {
		requiredValues, valid := requiredValue.([]any)
		if !valid {
			return nil, clierror.Unexpected(errors.New("provider configuration schema required fields are invalid"))
		}
		for _, value := range requiredValues {
			key, valid := value.(string)
			if !valid {
				return nil, clierror.Unexpected(errors.New("provider configuration schema required field is invalid"))
			}
			required[key] = struct{}{}
		}
	}

	result := make([]providerConfigurationProperty, 0, len(properties))
	for key, value := range properties {
		property, valid := value.(map[string]any)
		if !valid {
			return nil, clierror.Unexpected(errors.New("provider configuration schema property is invalid"))
		}
		valueType, valid := property["type"].(string)
		if !valid {
			return nil, clierror.Unexpected(errors.New("provider configuration schema property type is invalid"))
		}
		switch valueType {
		case "array", "boolean", "integer", "number", "string":
		default:
			return nil, clierror.Unexpected(errors.New("provider configuration schema property type is unsupported"))
		}
		constraints, err := providerPropertyConstraints(property, valueType)
		if err != nil {
			return nil, clierror.Unexpected(err)
		}
		writeOnly := false
		if rawWriteOnly, present := property["writeOnly"]; present {
			writeOnly, valid = rawWriteOnly.(bool)
			if !valid || (writeOnly && valueType != "string") {
				return nil, clierror.Unexpected(errors.New("provider configuration schema write-only property is invalid"))
			}
		}
		title := key
		if rawTitle, present := property["title"]; present {
			title, valid = rawTitle.(string)
			if !valid {
				return nil, clierror.Unexpected(errors.New("provider configuration schema title is invalid"))
			}
		}
		description := ""
		if rawDescription, present := property["description"]; present {
			description, valid = rawDescription.(string)
			if !valid {
				return nil, clierror.Unexpected(errors.New("provider configuration schema description is invalid"))
			}
		}
		order := float64(0)
		hasOrder := false
		if rawOrder, present := property["x-nama-order"]; present {
			numericOrder, numeric := rawOrder.(float64)
			if !numeric || math.Trunc(numericOrder) != numericOrder || math.Abs(numericOrder) > 9_007_199_254_740_991 {
				return nil, clierror.Unexpected(errors.New("provider configuration schema order is invalid"))
			}
			order = numericOrder
			hasOrder = true
		}
		defaultValue, hasDefault := property["default"]
		_, isRequired := required[key]
		configurationProperty := providerConfigurationProperty{
			constraints:  constraints,
			defaultValue: defaultValue,
			description:  description,
			hasDefault:   hasDefault,
			hasOrder:     hasOrder,
			key:          key,
			order:        order,
			required:     isRequired,
			title:        title,
			valueType:    valueType,
			writeOnly:    writeOnly,
		}
		if hasDefault {
			if err := validateProviderControlValue(defaultValue, configurationProperty); err != nil {
				return nil, clierror.Unexpected(err)
			}
		}
		result = append(result, configurationProperty)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].hasOrder != result[right].hasOrder {
			return result[left].hasOrder
		}
		if result[left].hasOrder && result[left].order != result[right].order {
			return result[left].order < result[right].order
		}
		return result[left].key < result[right].key
	})
	return result, nil
}

func providerControlValue(raw string, property providerConfigurationProperty) (any, error) {
	var value any
	switch property.valueType {
	case "string":
		value = raw
	case "boolean":
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errors.New("provider configuration value must be true or false")
		}
		value = parsed
	case "integer":
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil ||
			!isFinite(parsed) ||
			math.Trunc(parsed) != parsed ||
			math.Abs(parsed) > 9_007_199_254_740_991 {
			return nil, errors.New("provider configuration value must be an integer")
		}
		value = parsed
	case "number":
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || !isFinite(parsed) {
			return nil, errors.New("provider configuration value must be a finite number")
		}
		value = parsed
	case "array":
		var parsed []any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			return nil, errors.New("provider configuration value must be a JSON string array")
		}
		for _, item := range parsed {
			if _, valid := item.(string); !valid {
				return nil, errors.New("provider configuration value must be a JSON string array")
			}
		}
		value = parsed
	default:
		return nil, errors.New("provider configuration value type is unsupported")
	}
	if err := validateProviderControlValue(value, property); err != nil {
		return nil, err
	}
	return value, nil
}

func enumContains(values []any, candidate any) bool {
	for _, value := range values {
		if reflect.DeepEqual(value, candidate) {
			return true
		}
	}
	return false
}

func validProviderHostname(value string) bool {
	if value == "" || len(value) > 253 {
		return false
	}
	value = strings.TrimSuffix(value, ".")
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') &&
				(character < 'A' || character > 'Z') &&
				(character < '0' || character > '9') &&
				character != '-' {
				return false
			}
		}
	}
	return true
}

func validateProviderControlValue(value any, property providerConfigurationProperty) error {
	constraints := property.constraints
	switch property.valueType {
	case "array":
		items, valid := value.([]any)
		if !valid {
			return errors.New("provider configuration value must be a string array")
		}
		for _, item := range items {
			if _, valid := item.(string); !valid {
				return errors.New("provider configuration value must be a string array")
			}
		}
	case "boolean":
		if _, valid := value.(bool); !valid {
			return errors.New("provider configuration value must be a boolean")
		}
	case "integer":
		number, valid := value.(float64)
		if !valid ||
			!isFinite(number) ||
			math.Trunc(number) != number ||
			math.Abs(number) > 9_007_199_254_740_991 {
			return errors.New("provider configuration value must be an integer")
		}
	case "number":
		number, valid := value.(float64)
		if !valid || !isFinite(number) {
			return errors.New("provider configuration value must be a finite number")
		}
	case "string":
		if _, valid := value.(string); !valid {
			return errors.New("provider configuration value must be a string")
		}
	}
	if len(constraints.enumValues) > 0 && !enumContains(constraints.enumValues, value) {
		return errors.New("provider configuration value is not allowed")
	}
	switch typed := value.(type) {
	case string:
		length := len(typed)
		if constraints.hasMinimumSize && length < constraints.minimumSize {
			return errors.New("provider configuration value is too short")
		}
		if constraints.hasMaximumSize && length > constraints.maximumSize {
			return errors.New("provider configuration value is too long")
		}
		switch constraints.format {
		case "hostname":
			if !validProviderHostname(typed) {
				return errors.New("provider configuration value must be a hostname")
			}
		case "uri":
			parsed, err := url.ParseRequestURI(typed)
			if err != nil || !parsed.IsAbs() {
				return errors.New("provider configuration value must be an absolute URI")
			}
		}
	case float64:
		if constraints.hasMinimum && typed < constraints.minimum {
			return errors.New("provider configuration value is below the minimum")
		}
		if constraints.hasMaximum && typed > constraints.maximum {
			return errors.New("provider configuration value is above the maximum")
		}
	case []any:
		if constraints.hasMinimumSize && len(typed) < constraints.minimumSize {
			return errors.New("provider configuration array has too few items")
		}
		if constraints.hasMaximumSize && len(typed) > constraints.maximumSize {
			return errors.New("provider configuration array has too many items")
		}
		seen := make(map[string]struct{}, len(typed))
		for _, item := range typed {
			text, valid := item.(string)
			if !valid {
				return errors.New("provider configuration value must be a string array")
			}
			if len(constraints.itemEnumValues) > 0 {
				allowed := false
				for _, candidate := range constraints.itemEnumValues {
					if candidate == text {
						allowed = true
						break
					}
				}
				if !allowed {
					return errors.New("provider configuration array item is not allowed")
				}
			}
			if constraints.uniqueItems {
				if _, duplicate := seen[text]; duplicate {
					return errors.New("provider configuration array items must be unique")
				}
				seen[text] = struct{}{}
			}
		}
	}
	return nil
}

func isFinite(value float64) bool {
	return !math.IsInf(value, 0) && !math.IsNaN(value)
}

func providerPromptValue(value any) (string, error) {
	if text, ok := value.(string); ok {
		return output.HumanText(text), nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return output.HumanText(string(encoded)), nil
}

func providerControlHint(property providerConfigurationProperty) (string, error) {
	hints := make([]string, 0, 2)
	if len(property.constraints.enumValues) > 0 {
		values := make([]string, 0, len(property.constraints.enumValues))
		for _, value := range property.constraints.enumValues {
			visible, err := providerPromptValue(value)
			if err != nil {
				return "", err
			}
			values = append(values, visible)
		}
		hints = append(hints, "allowed: "+strings.Join(values, ", "))
	}
	switch {
	case property.constraints.format == "hostname":
		hints = append(hints, "hostname")
	case property.constraints.format == "password":
		hints = append(hints, "hidden")
	case property.constraints.format == "uri":
		hints = append(hints, "URI")
	case property.valueType == "array":
		hints = append(hints, "JSON string array")
	case property.valueType == "boolean":
		hints = append(hints, "true/false")
	}
	return strings.Join(hints, "; "), nil
}

func promptProviderConfiguration(
	command *cobra.Command,
	secretInput credentialauth.SecretInput,
	schema map[string]any,
	current *app.ProviderInstance,
) (map[string]any, error) {
	properties, err := providerConfigurationProperties(schema)
	if err != nil {
		return nil, err
	}
	configuredSecrets := make(map[string]struct{})
	if current != nil {
		for _, secret := range current.ConfiguredSecrets {
			if secret.Configured {
				configuredSecrets[secret.Key] = struct{}{}
			}
		}
	}
	reader := bufio.NewReader(command.InOrStdin())
	writer := command.ErrOrStderr()
	secretInput.Prompt = writer
	result := make(map[string]any)
	for _, property := range properties {
		label := output.HumanText(property.title)
		key := output.HumanText(property.key)
		if property.title != property.key {
			label += " (" + key + ")"
		}
		hint, err := providerControlHint(property)
		if err != nil {
			return nil, clierror.Unexpected(err)
		}
		if hint != "" {
			label += " [" + hint + "]"
		}
		if property.description != "" {
			if _, err := fmt.Fprintln(writer, output.HumanText(property.description)); err != nil {
				return nil, clierror.Unexpected(err)
			}
		}
		masked := property.writeOnly || property.constraints.format == "password"
		if masked {
			var retainedValue any
			hasRetainedValue := false
			if property.writeOnly {
				_, hasRetainedValue = configuredSecrets[property.key]
			} else if current != nil {
				retainedValue, hasRetainedValue = current.Configuration[property.key]
			}
			prompt := label + ": "
			if hasRetainedValue {
				prompt = label + " [configured; Enter to keep]: "
			} else if property.hasDefault {
				prompt = label + " [default available; Enter to accept]: "
			}
			raw, err := credentialauth.ReadTerminalSecret(secretInput, prompt)
			if err != nil {
				return nil, clierror.Unexpected(err)
			}
			if raw == "" {
				if hasRetainedValue {
					continue
				}
				if property.hasDefault {
					result[property.key] = property.defaultValue
					continue
				}
				if property.required {
					return nil, clierror.InvalidArgument(errors.New("required provider configuration value is missing"))
				}
				continue
			}
			value, err := providerControlValue(raw, property)
			if err != nil {
				return nil, clierror.InvalidArgument(err)
			}
			if hasRetainedValue && !property.writeOnly && reflect.DeepEqual(value, retainedValue) {
				continue
			}
			result[property.key] = value
			continue
		}

		var prefilled any
		hasPrefilled := false
		hasCurrentValue := false
		prefillLabel := "default"
		if current != nil {
			prefilled, hasCurrentValue = current.Configuration[property.key]
			hasPrefilled = hasCurrentValue
			prefillLabel = "current; Enter to keep"
		}
		if !hasPrefilled && property.hasDefault {
			prefilled = property.defaultValue
			hasPrefilled = true
			prefillLabel = "default"
		}
		prompt := label + ": "
		if hasPrefilled {
			visiblePrefill, err := providerPromptValue(prefilled)
			if err != nil {
				return nil, clierror.Unexpected(err)
			}
			prompt = fmt.Sprintf("%s [%s: %s]: ", label, prefillLabel, visiblePrefill)
		}
		if _, err := io.WriteString(writer, prompt); err != nil {
			return nil, clierror.Unexpected(err)
		}
		raw, readErr := reader.ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, clierror.Unexpected(readErr)
		}
		raw = strings.TrimSuffix(raw, "\n")
		raw = strings.TrimSuffix(raw, "\r")
		if raw == "" {
			if hasCurrentValue {
				continue
			}
			if hasPrefilled {
				result[property.key] = prefilled
				continue
			}
			if property.required {
				return nil, clierror.InvalidArgument(errors.New("required provider configuration value is missing"))
			}
			continue
		}
		value, err := providerControlValue(raw, property)
		if err != nil {
			return nil, clierror.InvalidArgument(err)
		}
		if hasCurrentValue && reflect.DeepEqual(value, prefilled) {
			continue
		}
		result[property.key] = value
	}
	return result, nil
}

func (r *runtime) interactiveProviderType(
	command *cobra.Command,
	state commandState,
	client apiv1.ProviderServiceClient,
	providerTypeID string,
) (app.ProviderType, error) {
	pageToken := ""
	seenTokens := make(map[string]struct{})
	for {
		page, err := app.ListProviderTypes(
			command.Context(),
			app.ListProviderTypesInput{
				Profile:   state.resolved.Profile,
				Server:    state.resolved.Server,
				PageSize:  100,
				PageToken: pageToken,
			},
			client,
			r.dependencies.Credentials,
		)
		if err != nil {
			return app.ProviderType{}, classifyLocalError(err)
		}
		for _, providerType := range page.ProviderTypes {
			if providerType.ID == providerTypeID {
				return providerType, nil
			}
		}
		if page.NextPageToken == "" {
			return app.ProviderType{}, clierror.New(
				clierror.CodeResourceNotFound,
				errors.New("provider type was not found"),
			)
		}
		if _, repeated := seenTokens[page.NextPageToken]; repeated {
			return app.ProviderType{}, clierror.Unexpected(errors.New("provider type pagination repeated a token"))
		}
		seenTokens[page.NextPageToken] = struct{}{}
		pageToken = page.NextPageToken
	}
}
