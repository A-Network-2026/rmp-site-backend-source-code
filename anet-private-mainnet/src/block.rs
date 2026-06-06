use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::transaction::Transaction;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub block_height: u64,
    pub epoch_start: DateTime<Utc>,
    pub epoch_end: DateTime<Utc>,
    pub previous_hash: String,
    pub hash: String,
    pub transactions: Vec<Transaction>,
    pub activated_supply_ants: u64,
    pub total_fees_ants: u64,
    pub miners: Vec<String>,
    pub fee_per_miner: u64,
}

#[derive(Debug, Clone, Serialize)]
struct BlockHashPayload<'a> {
    block_height: u64,
    epoch_start: DateTime<Utc>,
    epoch_end: DateTime<Utc>,
    previous_hash: &'a str,
    transactions: &'a [Transaction],
    activated_supply_ants: u64,
    total_fees_ants: u64,
    miners: &'a [String],
    fee_per_miner: u64,
}

impl Block {
    pub fn new(
        block_height: u64,
        epoch_start: DateTime<Utc>,
        epoch_end: DateTime<Utc>,
        previous_hash: String,
        transactions: Vec<Transaction>,
        activated_supply_ants: u64,
        miners: Vec<String>,
    ) -> Result<Self> {
        if epoch_end <= epoch_start {
            anyhow::bail!("block epoch_end must be greater than epoch_start");
        }

        for transaction in &transactions {
            transaction.validate()?;
        }

        let total_fees_ants = transactions.iter().map(|tx| tx.fee_ants).sum();
        let fee_per_miner = if miners.is_empty() {
            0
        } else {
            total_fees_ants / miners.len() as u64
        };

        let mut block = Self {
            block_height,
            epoch_start,
            epoch_end,
            previous_hash,
            hash: String::new(),
            transactions,
            activated_supply_ants,
            total_fees_ants,
            miners,
            fee_per_miner,
        };
        block.hash = block.compute_hash()?;
        Ok(block)
    }

    pub fn compute_hash(&self) -> Result<String> {
        let payload = BlockHashPayload {
            block_height: self.block_height,
            epoch_start: self.epoch_start,
            epoch_end: self.epoch_end,
            previous_hash: &self.previous_hash,
            transactions: &self.transactions,
            activated_supply_ants: self.activated_supply_ants,
            total_fees_ants: self.total_fees_ants,
            miners: &self.miners,
            fee_per_miner: self.fee_per_miner,
        };
        let encoded = serde_json::to_vec(&payload)?;
        let mut hasher = Sha256::new();
        hasher.update(encoded);
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn validate_hash(&self) -> Result<bool> {
        Ok(self.hash == self.compute_hash()?)
    }

    pub fn validate_structure(&self) -> Result<()> {
        if self.epoch_end <= self.epoch_start {
            anyhow::bail!(
                "stored block {} has invalid epoch window",
                self.block_height
            );
        }

        for transaction in &self.transactions {
            transaction.validate()?;
        }

        Ok(())
    }
}
