import { describe, expect, it } from 'vitest';
import { parseModuleGenerationGate } from './module-generation-gate';

const gate = {
  enabled: true,
  compileCommand: { executable: 'dotnet', args: ['build', 'Fixture.csproj', '--nologo', '-v', 'q'] },
  verification: {
    command: { executable: 'dotnet', args: ['exec', 'bin/Debug/net8.0/Fixture.dll'] },
    protectedFiles: ['Program.cs'],
  },
  maxModelTurns: 24,
};

describe('module generation gate', () => {
  it('stays disabled until local configuration enables it', () => {
    expect(parseModuleGenerationGate(undefined)).toBeUndefined();
    expect(parseModuleGenerationGate(null)).toBeUndefined();
    expect(parseModuleGenerationGate({ enabled: false })).toBeUndefined();
  });

  it('parses trusted local commands and a bounded model budget', () => {
    expect(parseModuleGenerationGate(gate)).toEqual({
      compileCommand: { executable: 'dotnet', args: ['build', 'Fixture.csproj', '--nologo', '-v', 'q'] },
      verification: {
        command: { executable: 'dotnet', args: ['exec', 'bin/Debug/net8.0/Fixture.dll'] },
        protectedFiles: ['Program.cs'],
      },
      maxModelTurns: 24,
    });
    expect(parseModuleGenerationGate({ ...gate, maxModelTurns: undefined })).toMatchObject({ maxModelTurns: 40 });
  });

  it('rejects absolute paths, unknown fields and unbounded budgets', () => {
    expect(() => parseModuleGenerationGate({ ...gate, unexpected: true })).toThrow(/未知字段/);
    expect(() => parseModuleGenerationGate({
      ...gate,
      compileCommand: { executable: 'dotnet', args: ['build'], cwd: 'C:/repository' },
    })).toThrow(/模块生成编译命令/);
    expect(() => parseModuleGenerationGate({
      ...gate,
      compileCommand: { executable: 'dotnet', args: ['build', 'D:/other/Fixture.csproj'] },
    })).toThrow(/绝对路径参数/);
    expect(() => parseModuleGenerationGate({
      ...gate,
      verification: { command: gate.verification.command, protectedFiles: [] },
    })).toThrow(/保护文件/);
    expect(() => parseModuleGenerationGate({
      ...gate,
      verification: { command: gate.verification.command, protectedFiles: ['../outside.cs'] },
    })).toThrow(/保护文件/);
    expect(() => parseModuleGenerationGate({ ...gate, maxModelTurns: 500 })).toThrow(/轮次预算/);
    expect(() => parseModuleGenerationGate({
      ...gate,
      compileCommand: { executable: '', args: [] },
    })).toThrow(/模块生成编译命令/);
  });
});
