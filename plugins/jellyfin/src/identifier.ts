const MINIMUM_IDENTIFIER_LENGTH = 1;
const FIRST_CHARACTER_INDEX = 0;
const CHARACTER_INCREMENT = 1;

const identifierViolationReason = (
  value: string,
  maximumLength: number,
): false | "OUT_OF_RANGE" | "REQUIRED" => {
  const characters = value[Symbol.iterator]();
  let length = FIRST_CHARACTER_INDEX;
  for (let character = characters.next(); character.done !== true; character = characters.next()) {
    length += CHARACTER_INCREMENT;
    if (length > maximumLength) {
      return "OUT_OF_RANGE";
    }
  }
  if (length < MINIMUM_IDENTIFIER_LENGTH) {
    return "REQUIRED";
  }
  return false;
};

export { identifierViolationReason };
