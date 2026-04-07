import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/solidity-parser/index.js";

const ERC20_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MyToken is ERC20, Ownable {
  uint256 public maxSupply;
  mapping(address => bool) public whitelist;
  bool private _paused;

  event Mint(address indexed to, uint256 amount);
  event Paused(bool status);

  function mint(address to, uint256 amount) public onlyOwner {
    require(totalSupply() + amount <= maxSupply, "Exceeds max supply");
    _mint(to, amount);
  }

  function pause() external onlyOwner {
    _paused = true;
  }

  function balanceOf(address account) public view override returns (uint256) {
    return super.balanceOf(account);
  }
}
`;

describe("Gene: solidity-parser", () => {
  it("parses an ERC20-like contract", () => {
    const result = express({ source: ERC20_SOURCE });

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].name).toBe("MyToken");
    expect(result.contracts[0].type).toBe("contract");
    expect(result.contracts[0].inherits).toContain("ERC20");
    expect(result.contracts[0].inherits).toContain("Ownable");

    expect(result.functions.length).toBeGreaterThanOrEqual(3);
    const mint = result.functions.find((f) => f.name === "mint");
    expect(mint).toBeDefined();
    expect(mint!.visibility).toBe("public");
    expect(mint!.modifiers).toContain("onlyOwner");

    const balanceOf = result.functions.find((f) => f.name === "balanceOf");
    expect(balanceOf).toBeDefined();
    expect(balanceOf!.mutability).toBe("view");

    expect(result.stateVariables.length).toBeGreaterThanOrEqual(2);
    const maxSupply = result.stateVariables.find((v) => v.name === "maxSupply");
    expect(maxSupply).toBeDefined();
    expect(maxSupply!.type).toBe("uint256");

    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.map((e) => e.name)).toContain("Mint");

    expect(result.imports).toHaveLength(2);
    expect(result.imports).toContain("@openzeppelin/contracts/token/ERC20/ERC20.sol");
  });

  it("returns empty arrays for empty source", () => {
    const result = express({ source: "" });

    expect(result.contracts).toHaveLength(0);
    expect(result.functions).toHaveLength(0);
    expect(result.stateVariables).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.imports).toHaveLength(0);
  });

  it("parses interfaces and libraries", () => {
    const source = `
pragma solidity ^0.8.0;

interface IERC721 {
  function ownerOf(uint256 tokenId) external view returns (address);
}

library SafeMath {
  function add(uint256 a, uint256 b) internal pure returns (uint256) {
    return a + b;
  }
}
`;
    const result = express({ source });

    expect(result.contracts).toHaveLength(2);
    const iface = result.contracts.find((c) => c.name === "IERC721");
    expect(iface).toBeDefined();
    expect(iface!.type).toBe("interface");

    const lib = result.contracts.find((c) => c.name === "SafeMath");
    expect(lib).toBeDefined();
    expect(lib!.type).toBe("library");

    const ownerOf = result.functions.find((f) => f.name === "ownerOf");
    expect(ownerOf).toBeDefined();
    expect(ownerOf!.visibility).toBe("external");
    expect(ownerOf!.mutability).toBe("view");

    const add = result.functions.find((f) => f.name === "add");
    expect(add).toBeDefined();
    expect(add!.mutability).toBe("pure");
  });

  it("strips comments before parsing", () => {
    const source = `
// contract FakeInComment {}
/* contract AlsoFake {} */
contract Real {
  // function fakeFunc() public {}
  function realFunc() external view returns (bool) {
    return true;
  }
}
`;
    const result = express({ source });

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].name).toBe("Real");
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].name).toBe("realFunc");
  });

  describe("display", () => {
    it("prints contract names and visibility badges for functions", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(express({ source: ERC20_SOURCE }));
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("MyToken");
      expect(text).toContain("🟢 public");
      expect(text).toContain("🔵 external");
      spy.mockRestore();
    });

    it("includes function params when verbose", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(express({ source: ERC20_SOURCE }), { verbose: true });
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("params:");
      expect(text).toContain("onlyOwner");
      spy.mockRestore();
    });

    it("shows event parameter detail only when verbose", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const out = express({ source: ERC20_SOURCE });
      display(out);
      const shortText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(shortText).toContain("Mint");
      expect(shortText).not.toContain("address indexed to");
      spy.mockClear();
      display(out, { verbose: true });
      const longText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(longText).toMatch(/Mint.*address indexed to/i);
      spy.mockRestore();
    });
  });
});
