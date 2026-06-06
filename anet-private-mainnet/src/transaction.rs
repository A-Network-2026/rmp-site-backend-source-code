use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use ripemd::Ripemd160;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ANET_ADDRESS_PREFIX: &str = "ANET";

/// Minimum transaction fee: 1 000 ANTS (0.00001 ANET).
/// Every transfer must include at least this fee, which is
/// distributed equally across all validator wallets in the block.
pub const MIN_FEE_ANTS: u64 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub from: String,
    pub to: String,
    pub amount_ants: u64,
    pub fee_ants: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub memo: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionRequest {
    pub from: String,
    pub to: String,
    pub amount_ants: u64,
    pub fee_ants: u64,
    #[serde(default)]
    pub memo: String,
    pub sender_seed: String,
}

impl TransactionRequest {
    pub fn into_transaction(self) -> Result<Transaction> {
        let from = self.from.trim().to_uppercase();
        let to = self.to.trim().to_uppercase();
        let memo = self.memo.trim().to_owned();
        let sender_seed = self.sender_seed.trim().to_owned();

        if sender_seed.is_empty() {
            return Err(anyhow!(
                "sender seed is required for private mainnet transaction authorization"
            ));
        }

        let derived_sender = derive_address_from_seed(&sender_seed);
        if derived_sender != from {
            return Err(anyhow!(
                "sender seed does not match the supplied ANET wallet"
            ));
        }

        let tx = Transaction {
            from,
            to,
            amount_ants: self.amount_ants,
            fee_ants: self.fee_ants,
            memo,
            timestamp: Utc::now(),
        };
        tx.validate()?;
        Ok(tx)
    }
}

impl Transaction {
    pub fn validate(&self) -> Result<()> {
        if self.from.is_empty() {
            return Err(anyhow!("transaction sender is required"));
        }

        if self.to.is_empty() {
            return Err(anyhow!("transaction recipient is required"));
        }

        if self.from == self.to {
            return Err(anyhow!("transaction sender and recipient must differ"));
        }

        if self.amount_ants == 0 {
            return Err(anyhow!("transaction amount must be greater than zero"));
        }

        if self.fee_ants < MIN_FEE_ANTS {
            return Err(anyhow!(
                "transaction fee must be at least {MIN_FEE_ANTS} ANTS (0.00001 ANET)"
            ));
        }

        if !is_valid_anet_wallet(&self.from) {
            return Err(anyhow!("transaction sender must be a valid ANET wallet"));
        }

        if !is_valid_anet_wallet(&self.to) {
            return Err(anyhow!("transaction recipient must be a valid ANET wallet"));
        }

        if self.memo.chars().count() > 160 {
            return Err(anyhow!("transaction memo must be 160 characters or fewer"));
        }

        if self
            .memo
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        {
            return Err(anyhow!(
                "transaction memo contains unsupported control characters"
            ));
        }

        Ok(())
    }

    pub fn id(&self) -> Result<String> {
        let payload = serde_json::to_vec(self)?;
        let mut hasher = Sha256::new();
        hasher.update(payload);
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn total_debit(&self) -> Result<u64> {
        self.amount_ants
            .checked_add(self.fee_ants)
            .ok_or_else(|| anyhow!("transaction total debit overflowed"))
    }
}

fn derive_address_from_seed(seed: &str) -> String {
    let private_key = hash_hex(seed);
    let public_key = hash_hex(&private_key);

    let mut hasher = Ripemd160::new();
    hasher.update(public_key.as_bytes());
    let wallet_hash = hex::encode_upper(hasher.finalize());
    format!("{ANET_ADDRESS_PREFIX}{}", &wallet_hash[..36])
}

fn hash_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn is_valid_anet_wallet(address: &str) -> bool {
    address.len() == 40
        && address.starts_with(ANET_ADDRESS_PREFIX)
        && address[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
        && address[4..].bytes().all(|byte| !byte.is_ascii_lowercase())
}

pub fn wallet_seed_matches(address: &str, seed: &str) -> bool {
    let normalized_address = address.trim().to_uppercase();
    if !is_valid_anet_wallet(&normalized_address) {
        return false;
    }

    derive_address_from_seed(seed.trim()) == normalized_address
}

#[cfg(test)]
mod tests {
    use super::{derive_address_from_seed, TransactionRequest};

    #[test]
    fn accepts_matching_seed_authorization() {
        let seed = "apple banana cat dog earth fire gold house ice jungle king lemon";
        let from = derive_address_from_seed(seed);
        let request = TransactionRequest {
            from,
            to: "ANET1234567890ABCDEF1234567890ABCDEF1234".to_owned(),
            amount_ants: 100,
            fee_ants: 1,
            memo: "Payroll settlement".to_owned(),
            sender_seed: seed.to_owned(),
        };

        let transaction = request
            .into_transaction()
            .expect("transaction should validate");
        assert_eq!(transaction.amount_ants, 100);
        assert_eq!(transaction.memo, "Payroll settlement");
    }

    #[test]
    fn rejects_mismatched_seed_authorization() {
        let request = TransactionRequest {
            from: "ANET1234567890ABCDEF1234567890ABCDEF1234".to_owned(),
            to: "ANETFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF".to_owned(),
            amount_ants: 100,
            fee_ants: 1,
            memo: String::new(),
            sender_seed: "apple banana cat dog earth fire gold house ice jungle king lemon"
                .to_owned(),
        };

        let error = request
            .into_transaction()
            .expect_err("transaction should fail");
        assert!(error
            .to_string()
            .contains("sender seed does not match the supplied ANET wallet"));
    }
}
