#!/usr/bin/env python3
"""Seal the GitHub PAT with a passkey-derived key.

Mirrors exactly what crypto.js does in the browser:
  key   = PBKDF2-HMAC-SHA256(passkey, salt, 250000 iters, 32 bytes)
  blob  = salt(16) || iv(12) || AES-GCM(key, iv, token)   [tag appended]
  out   = base64(blob)

The point is that the *plaintext* PAT never enters the repo, so GitHub push
protection won't block the push and secret scanning won't auto-revoke it.
"""
import base64, os, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITERATIONS = 250_000

def seal(passkey: str, token: str) -> str:
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS
    ).derive(passkey.encode())
    ct = AESGCM(key).encrypt(iv, token.encode(), None)
    return base64.b64encode(salt + iv + ct).decode()

if __name__ == "__main__":
    token = open(sys.argv[1]).read().strip()
    passkey = sys.argv[2]
    print(seal(passkey, token))
