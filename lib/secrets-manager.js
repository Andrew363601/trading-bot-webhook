// lib/secrets-manager.js
import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt API key/secret for vault storage.
 * Uses PBKDF2 for key derivation based on a master key and tenantId.
 */
export function encryptSecret(plaintext, masterKey, tenantId) {
    try {
        const salt = Buffer.from(tenantId).toString('hex').slice(0, 16);
        const key = crypto.pbkdf2Sync(masterKey, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
        let encrypted = cipher.update(plaintext, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
        throw new Error(`Encryption failed: ${error.message}`);
    }
}

/**
 * Decrypt API key/secret from vault.
 */
export function decryptSecret(encryptedData, masterKey, tenantId) {
    try {
        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        
        const salt = Buffer.from(tenantId).toString('hex').slice(0, 16);
        const key = crypto.pbkdf2Sync(masterKey, salt, 100000, 32, 'sha256');
        
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

/**
 * Store API key in vault (encrypted).
 */
export async function storeAPIKey(supabase, tenantId, exchange, apiKey, apiSecret) {
    const masterKey = process.env.MASTER_ENCRYPTION_KEY;
    if (!masterKey) throw new Error('MASTER_ENCRYPTION_KEY not set');
    
    const encryptedKey = encryptSecret(apiKey, masterKey, tenantId);
    const encryptedSecret = encryptSecret(apiSecret, masterKey, tenantId);
    
    const { error } = await supabase
        .from('api_keys_vault')
        .upsert({
            tenant_id: tenantId,
            exchange: exchange.toUpperCase(),
            key_encrypted: encryptedKey,
            secret_encrypted: encryptedSecret,
            is_active: true
        }, { onConflict: 'tenant_id,exchange' });
    
    if (error) throw error;
    return { success: true };
}

/**
 * Retrieve and decrypt API keys for a tenant.
 */
export async function retrieveAPIKey(supabase, tenantId, exchange) {
    const masterKey = process.env.MASTER_ENCRYPTION_KEY;
    if (!masterKey) throw new Error('MASTER_ENCRYPTION_KEY not set');
    
    const { data, error } = await supabase
        .from('api_keys_vault')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('exchange', exchange.toUpperCase())
        .eq('is_active', true)
        .single();
    
    if (error || !data) throw new Error(`Keys not found for ${exchange}`);
    
    return {
        apiKey: decryptSecret(data.key_encrypted, masterKey, tenantId),
        apiSecret: decryptSecret(data.secret_encrypted, masterKey, tenantId)
    };
}
