import { randomBytes, randomInt, scryptSync } from "node:crypto";

const PASSWORD_LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const PASSWORD_UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_DIGITS = "23456789";

function randomCharacter(characters) {
  return characters[randomInt(characters.length)];
}

export function generateRandomPassword(length = 12) {
  if (!Number.isSafeInteger(length) || length < 3) {
    throw new Error("Password length must be at least 3 characters");
  }

  const allCharacters = PASSWORD_LOWERCASE + PASSWORD_UPPERCASE + PASSWORD_DIGITS;
  const password = [
    randomCharacter(PASSWORD_LOWERCASE),
    randomCharacter(PASSWORD_UPPERCASE),
    randomCharacter(PASSWORD_DIGITS),
  ];

  while (password.length < length) password.push(randomCharacter(allCharacters));
  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [password[index], password[swapIndex]] = [password[swapIndex], password[index]];
  }
  return password.join("");
}

/** Hash a password with a per-password salt for synchronous bootstrap paths. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
