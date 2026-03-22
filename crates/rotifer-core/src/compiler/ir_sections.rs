//! Custom section builders for Rotifer IR modules.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::gene::Phenotype;

/// Current IR specification version string.
pub const IR_SPEC_VERSION: &str = "0.2.0";
/// Numeric IR format version.
pub const IR_VERSION: u32 = 2;

/// Version section embedded in `rotifer.version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionSection {
    pub spec_version: String,
    pub ir_version: u32,
}

impl Default for VersionSection {
    fn default() -> Self {
        Self {
            spec_version: IR_SPEC_VERSION.to_string(),
            ir_version: IR_VERSION,
        }
    }
}

/// Phenotype section — serialized subset for IR embedding.
/// Matches IR spec §8.2.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhenotypeSection {
    pub domain: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub version: String,
    pub author: Vec<u8>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fidelity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkSectionConfig>,
}

/// Network configuration subset embedded in the IR phenotype section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkSectionConfig {
    pub allowed_domains: Vec<String>,
    pub max_timeout_ms: u32,
    pub max_response_bytes: u64,
    pub max_requests_per_min: u32,
}

impl From<&Phenotype> for PhenotypeSection {
    fn from(p: &Phenotype) -> Self {
        use crate::types::gene::Fidelity;

        let network = p.network.as_ref().map(|n| NetworkSectionConfig {
            allowed_domains: n.allowed_domains.clone(),
            max_timeout_ms: n.max_timeout_ms,
            max_response_bytes: n.max_response_bytes,
            max_requests_per_min: n.max_requests_per_min,
        });

        let fidelity = match p.fidelity {
            Fidelity::Wrapped => None,
            Fidelity::Hybrid => Some("Hybrid".to_string()),
            Fidelity::Native => Some("Native".to_string()),
            Fidelity::Unknown => None,
        };

        Self {
            domain: p.domain.clone(),
            input_schema: p.input_schema.clone(),
            output_schema: p.output_schema.clone(),
            version: p.version.clone(),
            author: p.author.as_bytes().to_vec(),
            created_at: p.created_at,
            description: None,
            tags: p.regulatory_tags.clone(),
            fidelity,
            network,
        }
    }
}

/// Constraints section — IR spec §8.3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstraintsSection {
    pub memory: MemoryConstraints,
    pub fuel: FuelConstraints,
    pub output: OutputConstraints,
    pub host_functions: Vec<String>,
}

/// Memory limits within the constraints section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConstraints {
    pub max_initial_pages: u32,
    pub max_grow_pages: u32,
    pub total_memory_limit: u32,
}

/// Fuel budget and per-instruction costs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuelConstraints {
    pub max_fuel: u64,
    pub fuel_per_instruction: FuelPerInstruction,
}

/// Per-category fuel costs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuelPerInstruction {
    pub arithmetic: u32,
    pub memory: u32,
    pub control: u32,
    pub host_call: u32,
}

/// Limits on gene output size.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputConstraints {
    pub max_output_size: u32,
}

impl Default for ConstraintsSection {
    fn default() -> Self {
        Self {
            memory: MemoryConstraints {
                max_initial_pages: 16,
                max_grow_pages: 64,
                total_memory_limit: 5_242_880,
            },
            fuel: FuelConstraints {
                max_fuel: 1_000_000,
                fuel_per_instruction: FuelPerInstruction {
                    arithmetic: 1,
                    memory: 2,
                    control: 1,
                    host_call: 100,
                },
            },
            output: OutputConstraints {
                max_output_size: 1_048_576,
            },
            host_functions: vec![
                "rotifer.log".into(),
                "rotifer.readContext".into(),
                "rotifer.remainingBudget".into(),
                "rotifer.logicalTimestamp".into(),
            ],
        }
    }
}

/// Metering section — fuel configuration for runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeteringSection {
    pub fuel_per_instruction: u32,
    pub fuel_per_memory_page: u32,
    pub fuel_per_host_call: u32,
}

impl Default for MeteringSection {
    fn default() -> Self {
        Self {
            fuel_per_instruction: 1,
            fuel_per_memory_page: 1000,
            fuel_per_host_call: 100,
        }
    }
}

/// All custom section names as constants.
pub const SECTION_VERSION: &str = "rotifer.version";
pub const SECTION_PHENOTYPE: &str = "rotifer.phenotype";
pub const SECTION_CONSTRAINTS: &str = "rotifer.constraints";
pub const SECTION_METERING: &str = "rotifer.metering";
pub const SECTION_DEPENDENCIES: &str = "rotifer.dependencies";
pub const SECTION_EXT: &str = "rotifer.ext";
pub const SECTION_SOURCE: &str = "rotifer.source";

/// Serialized custom section payload ready for WASM embedding.
#[derive(Debug, Clone)]
pub struct CustomSectionPayloads {
    pub version: Vec<u8>,
    pub phenotype: Vec<u8>,
    pub constraints: Vec<u8>,
    pub metering: Vec<u8>,
}

impl CustomSectionPayloads {
    /// Build all required custom section payloads from a Phenotype and optional overrides.
    pub fn build(
        phenotype: &Phenotype,
        constraints: Option<ConstraintsSection>,
        metering: Option<MeteringSection>,
    ) -> Result<Self, rmp_serde::encode::Error> {
        let version = VersionSection::default();
        let pheno_section = PhenotypeSection::from(phenotype);
        let constraints = constraints.unwrap_or_default();
        let metering = metering.unwrap_or_default();

        Ok(Self {
            version: rmp_serde::to_vec_named(&version)?,
            phenotype: rmp_serde::to_vec_named(&pheno_section)?,
            constraints: rmp_serde::to_vec_named(&constraints)?,
            metering: rmp_serde::to_vec_named(&metering)?,
        })
    }

    /// Compute irHash per spec §8.4:
    /// SHA-256(version_section || phenotype_section || constraints_section || wasm_code_section)
    pub fn compute_ir_hash(&self, wasm_code_section: &[u8]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(&self.version);
        hasher.update(&self.phenotype);
        hasher.update(&self.constraints);
        hasher.update(wasm_code_section);
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_phenotype() -> Phenotype {
        use crate::types::gene::{Fidelity, GeneTransparency};
        Phenotype {
            domain: "test.echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "test-author".into(),
            created_at: 1000,
            ir_hash: None,
            fidelity: Fidelity::Native,
            source_framework: None,
            regulatory_tags: None,
            transparency: GeneTransparency::Open,
            streaming_capability: None,
            pricing_hint: None,
            semantic_requirements: None,
            network: None,
            llm_requirements: None,
            guard_config: None,
        }
    }

    #[test]
    fn build_custom_sections() {
        let pheno = test_phenotype();
        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();
        assert!(!payloads.version.is_empty());
        assert!(!payloads.phenotype.is_empty());
        assert!(!payloads.constraints.is_empty());
        assert!(!payloads.metering.is_empty());
    }

    #[test]
    fn version_section_roundtrip() {
        let v = VersionSection::default();
        let bytes = rmp_serde::to_vec_named(&v).unwrap();
        let decoded: VersionSection = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.spec_version, IR_SPEC_VERSION);
        assert_eq!(decoded.ir_version, IR_VERSION);
    }

    #[test]
    fn phenotype_section_roundtrip() {
        let pheno = test_phenotype();
        let section = PhenotypeSection::from(&pheno);
        let bytes = rmp_serde::to_vec_named(&section).unwrap();
        let decoded: PhenotypeSection = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.domain, "test.echo");
        assert_eq!(decoded.version, "0.1.0");
    }

    #[test]
    fn constraints_section_defaults() {
        let c = ConstraintsSection::default();
        assert_eq!(c.memory.max_initial_pages, 16);
        assert_eq!(c.fuel.max_fuel, 1_000_000);
        assert_eq!(c.output.max_output_size, 1_048_576);
    }

    #[test]
    fn ir_hash_deterministic() {
        let pheno = test_phenotype();
        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();
        let code = b"fake wasm code section";
        let hash1 = payloads.compute_ir_hash(code);
        let hash2 = payloads.compute_ir_hash(code);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn ir_hash_changes_with_code() {
        let pheno = test_phenotype();
        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();
        let hash1 = payloads.compute_ir_hash(b"code_v1");
        let hash2 = payloads.compute_ir_hash(b"code_v2");
        assert_ne!(hash1, hash2);
    }
}
