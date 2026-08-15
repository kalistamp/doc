/* ============================================================
   DOCKET SHARING — passkey → token

   Undoes what tools/seal.py did. The sealed blob is laid out as

       salt(16) || iv(12) || AES-GCM ciphertext(+16 byte tag)

   base64'd, and the AES key is PBKDF2-SHA256 over the passkey. Both
   sides have to agree on the iteration count, which is why it lives in
   config.js rather than being written twice.
   ============================================================ */

(function () {
    const b64ToBytes = (b64) => {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    };

    async function deriveKey(passkey, salt, iterations) {
        const material = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(passkey), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
    }

    /**
     * Decrypt the sealed PAT.
     * @returns {Promise<string>} the token
     * @throws if the passkey is wrong or the blob is malformed — AES-GCM
     *         authenticates, so a bad key fails loudly instead of handing
     *         back plausible garbage.
     */
    async function unseal(sealedB64, passkey, iterations) {
        const blob = b64ToBytes(sealedB64);
        if (blob.length < 16 + 12 + 16) throw new Error('Sealed token is truncated.');

        const salt = blob.slice(0, 16);
        const iv = blob.slice(16, 28);
        const body = blob.slice(28);

        const key = await deriveKey(passkey, salt, iterations);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
        return new TextDecoder().decode(plain);
    }

    window.DocketCrypto = { unseal };
})();
