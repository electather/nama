# Make provider-secret classification monotonic

Once Nama accepts a provider configuration key as write-only, it persists that classification and rejects a later schema revision that removes it or changes its type. Replacing a secret requires a new key and explicit migration, restricting schema evolution so a plugin update cannot expose stored ciphertext through management responses.
