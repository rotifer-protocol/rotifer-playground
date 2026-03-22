---
name: license-advisor
description: Analyze project requirements and recommend suitable open source licenses (MIT, Apache, GPL, AGPL, LGPL, MPL, BSL, SSPL, etc.). Use when the user asks about licensing, choosing a license, open source strategy, or mentions license names like MIT/GPL/Apache.
---

# License Advisor

Help users select the most appropriate open source license by analyzing their product requirements, business model, and goals.

## Analysis Process

### Step 1: Gather Project Context

Ask the user about:

1. **Project type**: Library, framework, application, SaaS, developer tool?
2. **Business model**: Open core, SaaS, support/consulting, donations, fully open?
3. **Key concerns**: (rank by priority)
   - Monetization and commercial protection
   - Preventing cloud providers from competing
   - Maximizing adoption and contributions
   - Ensuring derivatives stay open
   - Patent protection

### Step 2: Apply Decision Matrix

| Requirement | Recommended Licenses |
|-------------|---------------------|
| Maximum adoption, minimal restrictions | MIT, ISC, Unlicense |
| Adoption + patent protection | Apache 2.0 |
| Derivatives must stay open (weak copyleft) | LGPL, MPL 2.0 |
| All derivatives must be open (strong copyleft) | GPL v3 |
| Network/SaaS derivatives must be open | AGPL v3 |
| Time-delayed open source | BSL 1.1 |
| Prevent cloud competition | SSPL, Elastic License, FSL |
| Dual licensing strategy | GPL + Commercial |

### Step 3: Provide Recommendation

Format your recommendation as:

```markdown
## License Recommendation

**Primary recommendation**: [License Name]
**Alternative options**: [Other suitable licenses]

### Why this license fits your needs

[2-3 bullet points explaining the match]

### Key considerations

- [Important implication 1]
- [Important implication 2]

### Compatibility notes

[Dependencies, ecosystem considerations]
```

## Quick Reference

### Permissive Licenses (Business-friendly)

| License | Patent Grant | Attribution | Key Use Case |
|---------|-------------|-------------|--------------|
| MIT | No | Yes | Maximum adoption |
| Apache 2.0 | Yes | Yes | Corporate-friendly, patent protection |
| BSD 3-Clause | No | Yes | Similar to MIT |
| ISC | No | Yes | Simplified MIT |

### Copyleft Licenses (Community-focused)

| License | Scope | Network Trigger | Key Use Case |
|---------|-------|-----------------|--------------|
| GPL v3 | Full | No | Ensure all derivatives open |
| LGPL v3 | Library boundary | No | Open libraries, closed apps OK |
| MPL 2.0 | File-level | No | Per-file copyleft |
| AGPL v3 | Full | Yes | SaaS must share code |

### Source-Available Licenses (Commercial protection)

| License | After Delay | Cloud Restriction | Key Use Case |
|---------|-------------|-------------------|--------------|
| BSL 1.1 | Configurable (typically 4yr) | Production use restricted | Delayed open source |
| SSPL | Never (not OSI) | Must open entire stack | Anti-cloud provider |
| Elastic 2.0 | No | SaaS restriction | Similar to SSPL, less strict |
| FSL | 2 years → Apache/MIT | Production restricted | Functional Source |

## Common Scenarios

### "I want maximum adoption"
→ **MIT** or **Apache 2.0** (if patent protection needed)

### "I'm building a SaaS and competitors might use my code"
→ **AGPL v3** (if open source important) or **BSL/SSPL** (if commercial protection priority)

### "I want contributions back but allow commercial use"
→ **LGPL v3** (for libraries) or **MPL 2.0** (file-level copyleft)

### "I want to sell commercial licenses"
→ **GPL v3 + Commercial dual license** or **BSL 1.1**

### "I hate cloud providers using my work"
→ **SSPL**, **Elastic License 2.0**, or **FSL**

## Detailed Reference

For comprehensive license details, compatibility matrices, and legal considerations, see [LICENSES.md](LICENSES.md).

## Important Caveats

1. **Not legal advice**: Always recommend consulting a lawyer for commercial decisions
2. **Dependency compatibility**: Check that chosen license is compatible with dependencies
3. **CLA considerations**: For contributions, consider if a CLA is needed
4. **Relicensing**: Changing licenses later requires all contributors' consent (or CLA)
