"""Shared C# compilation support for the adaptation POC scripts."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


POC_ROOT = Path(__file__).resolve().parent


DOMAIN_STUBS = """// ---- POC compilation fixtures ----
public class OrderItem {
    public decimal Price { get; set; }
    public int Quantity { get; set; }
    public string Category { get; set; }
    public string ProductId { get; set; }

    public OrderItem() {
        Category = "";
        ProductId = "";
    }
}

public class Discount {
    public bool IsValid() { return true; }
    public decimal Apply(decimal total) { return total * 0.9m; }
}

public class Order {
    public List<OrderItem> Items { get; set; }
    public string Customer { get; set; }

    public Order() {
        Items = new List<OrderItem>();
        Customer = "";
    }
}

public class PaymentRequest {
    public decimal Amount { get; set; }
    public string AccountId { get; set; }

    public PaymentRequest() {
        AccountId = "";
    }
}

public class PaymentResult {
    public bool Success { get; set; }
}

public class Account {
    public decimal Balance { get; set; }
}

public class InsufficientFundsException : Exception {
    public InsufficientFundsException(string message) : base(message) { }
}

public class PaymentFailedException : Exception {
    public PaymentFailedException(string message, Exception inner) : base(message, inner) { }
}

public class GatewayException : Exception { }

public class AccountRepository {
    public Account FindById(string id) { return new Account { Balance = 1000m }; }
    public void Save(Account account) { }
}

public class PaymentGateway {
    public PaymentResult Charge(PaymentRequest request) {
        return new PaymentResult { Success = true };
    }
}
"""


def compiler_status() -> dict:
    dotnet = _find_dotnet_sdk()
    if dotnet:
        return {"available": True, "kind": "dotnet", "command": dotnet}
    csc = _find_csc()
    if csc:
        return {"available": True, "kind": "csc", "command": csc}
    return {"available": False, "kind": None, "command": None}


def compile_csharp(code: str, class_name: str) -> dict:
    """Compile one generated method against bounded POC domain fixtures."""
    compiler = compiler_status()
    if not compiler["available"]:
        return {
            "success": False,
            "errors": ["No usable .NET SDK or C# compiler was found."],
            "output": "",
            "compiler": None,
            "unavailable": True,
        }

    full_source = _wrapper_source(code, class_name)
    temporary = Path(tempfile.mkdtemp(prefix=".forexplore-poc-", dir=POC_ROOT))
    source_file = temporary / f"{class_name}.cs"
    source_file.write_text(full_source, encoding="utf-8")

    try:
        if compiler["kind"] == "dotnet":
            result = _compile_with_dotnet(compiler["command"], temporary)
        else:
            result = _compile_with_csc(compiler["command"], temporary, source_file)
        combined = "\n".join(part for part in [result.stdout, result.stderr] if part)
        return {
            "success": result.returncode == 0,
            "errors": [] if result.returncode == 0 else _parse_errors(combined),
            "output": combined.strip() or "compile passed",
            "compiler": compiler["kind"],
            "unavailable": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "errors": ["C# compilation timed out."],
            "output": "",
            "compiler": compiler["kind"],
            "unavailable": False,
        }
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _wrapper_source(code: str, class_name: str) -> str:
    return f"""using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;

{DOMAIN_STUBS}

public class {class_name} {{
    private static readonly AccountRepository accountRepository = new AccountRepository();
    private static readonly PaymentGateway paymentGateway = new PaymentGateway();

{code.strip()}
}}
"""


def _find_dotnet_sdk() -> str | None:
    candidates = [
        os.environ.get("DOTNET_COMMAND", "").strip(),
        shutil.which("dotnet") or "",
        "/mnt/c/Program Files/dotnet/dotnet.exe",
    ]
    for candidate in _unique_existing(candidates):
        try:
            result = subprocess.run(
                [candidate, "--list-sdks"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return candidate
    return None


def _find_csc() -> str | None:
    system_root = os.environ.get("SystemRoot", "/mnt/c/Windows")
    candidates = [
        os.environ.get("CSC_COMMAND", "").strip(),
        shutil.which("csc") or "",
        str(Path(system_root) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
        str(Path(system_root) / "Microsoft.NET/Framework/v4.0.30319/csc.exe"),
        "/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
        "/mnt/c/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
    ]
    return next(iter(_unique_existing(candidates)), None)


def _unique_existing(candidates: list[str]):
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if shutil.which(candidate) or Path(candidate).is_file():
            yield candidate


def _compile_with_dotnet(command: str, directory: Path) -> subprocess.CompletedProcess[str]:
    project = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>"""
    (directory / "tmp.csproj").write_text(project, encoding="utf-8")
    return subprocess.run(
        [command, "build", "--nologo", "-v", "q"],
        cwd=directory,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def _compile_with_csc(
    command: str,
    directory: Path,
    source_file: Path,
) -> subprocess.CompletedProcess[str]:
    output_file = directory / "baseline.dll"
    source_arg = _compiler_path(command, source_file)
    output_arg = _compiler_path(command, output_file)
    return subprocess.run(
        [
            command,
            "/target:library",
            f"/out:{output_arg}",
            "/nologo",
            "/utf8output",
            source_arg,
        ],
        cwd=directory,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )


def _compiler_path(command: str, path: Path) -> str:
    if os.name == "nt" or not command.lower().endswith(".exe"):
        return str(path)
    try:
        return subprocess.check_output(
            ["wslpath", "-w", str(path)],
            text=True,
            timeout=5,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return str(path)


def _parse_errors(output: str) -> list[str]:
    errors = [
        line.strip()
        for line in output.splitlines()
        if re.search(r"\berror\s+CS\d+\b", line, re.IGNORECASE)
    ]
    return errors or [line.strip() for line in output.splitlines() if line.strip()][-5:]
