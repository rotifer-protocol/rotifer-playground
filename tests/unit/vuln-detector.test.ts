import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/vuln-detector/index.js";

const CLEAN_CONTRACT = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Vault is ReentrancyGuard {
  mapping(address => uint256) public balances;

  function deposit() external payable {
    balances[msg.sender] += msg.value;
  }

  function withdraw(uint256 amount) external nonReentrant {
    require(balances[msg.sender] >= amount, "Insufficient");
    balances[msg.sender] -= amount;
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success, "Transfer failed");
  }
}
`;

const REENTRANCY_CONTRACT = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

contract UnsafeVault {
  mapping(address => uint256) public balances;

  function withdraw(uint256 amount) external {
    (bool success, ) = msg.sender.call{value: amount}("");
    balances[msg.sender] -= amount;
  }
}
`;

const UNLOCKED_PRAGMA = `
pragma solidity ^0.8.0;

contract Simple {
  uint256 public value;

  function setValue(uint256 v) external {
    value = v;
  }
}
`;

describe("Gene: vuln-detector", () => {
  it("reports no vulnerabilities for a clean contract", () => {
    const result = express({ source: CLEAN_CONTRACT });

    expect(result.riskScore).toBe(100);
    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.summary).toContain("No vulnerabilities");
  });

  it("detects reentrancy vulnerability", () => {
    const result = express({ source: REENTRANCY_CONTRACT });

    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    const reentrancy = result.vulnerabilities.find((v) => v.type === "Reentrancy");
    expect(reentrancy).toBeDefined();
    expect(reentrancy!.severity).toBe("critical");
    expect(result.riskScore).toBeLessThan(100);
  });

  it("detects unlocked pragma", () => {
    const result = express({ source: UNLOCKED_PRAGMA });

    const pragma = result.vulnerabilities.find((v) => v.type === "Unlocked Pragma");
    expect(pragma).toBeDefined();
    expect(pragma!.severity).toBe("low");
    expect(pragma!.recommendation).toContain("Lock");
  });

  it("detects tx.origin misuse", () => {
    const source = `
pragma solidity 0.8.20;
contract Phishable {
  address public owner;
  function withdraw() external {
    require(tx.origin == owner, "Not owner");
    payable(msg.sender).transfer(address(this).balance);
  }
}
`;
    const result = express({ source });

    const txOrigin = result.vulnerabilities.find((v) => v.type === "tx.origin Authentication");
    expect(txOrigin).toBeDefined();
    expect(txOrigin!.severity).toBe("high");
  });

  it("detects selfdestruct usage", () => {
    const source = `
pragma solidity 0.8.20;
contract Destroyable {
  function destroy() external {
    selfdestruct(payable(msg.sender));
  }
}
`;
    const result = express({ source });

    const sd = result.vulnerabilities.find((v) => v.type === "Selfdestruct");
    expect(sd).toBeDefined();
    expect(sd!.severity).toBe("critical");
  });

  it("calculates risk score correctly with multiple vulnerabilities", () => {
    const source = `
pragma solidity ^0.7.0;
contract Dangerous {
  mapping(address => uint256) public balances;
  function withdraw() external {
    msg.sender.call{value: balances[msg.sender]}("");
    balances[msg.sender] = 0;
    selfdestruct(payable(msg.sender));
  }
}
`;
    const result = express({ source });

    expect(result.vulnerabilities.length).toBeGreaterThanOrEqual(2);
    expect(result.riskScore).toBeLessThanOrEqual(60);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain("critical");
  });

  describe("display", () => {
    it("prints risk bar and health label for clean output", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(express({ source: CLEAN_CONTRACT }));
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("Risk score");
      expect(text).toContain("/100");
      expect(text).toContain("Low");
      expect(text).toContain("No vulnerabilities");
      spy.mockRestore();
    });

    it("groups findings by severity when issues exist", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(express({ source: REENTRANCY_CONTRACT }));
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("CRITICAL");
      expect(text).toContain("Reentrancy");
      spy.mockRestore();
    });

    it("includes full descriptions in verbose mode", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const out = express({ source: REENTRANCY_CONTRACT });
      display(out);
      const shortText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(shortText).not.toContain("Description:");
      spy.mockClear();
      display(out, { verbose: true });
      const longText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(longText).toContain("Description:");
      expect(longText).toContain("Recommendation:");
      spy.mockRestore();
    });
  });
});
