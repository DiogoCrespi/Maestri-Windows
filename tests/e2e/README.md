# E2E web preview e lacunas nativas

Os specs deste diretório executam a UI compilada com Playwright. Eles validam
o painel acessível de Presets/Roles, criação e persistência local de
configurações, aplicação ao editor de terminal, `command`, `agentType` e role
atribuído, além dos fluxos básicos já existentes de workspace, nota, arquivos,
zoom/pan e terminal.

## Limites do preview web

O preview não é Tauri e não cria ConPTYs. O spec instala somente um shim de
`shell_list` para que o formulário possa carregar uma opção de PowerShell;
`createPty`, eventos nativos, resize, escrita e encerramento não são uma
prova do backend Windows. Preferências e notas usam o `localStorage` do
preview, não o filesystem nativo nem os comandos Tauri.

Import/export é exercitado quando o painel está disponível, mas valida o JSON
da store web e não diálogos de arquivo nativos.

## Routines no preview

`routines-preview.spec.ts` abre o botão **Rotinas** no canvas, cria um
terminal pelo fluxo real da UI, usa o UUID/nome desse terminal como target,
cria e edita uma rotina, alterna ON/OFF, valida os campos `once` e
`untilTimestamp`, executa `Run now` e confirma a persistência após reload.

No preview web, `Run now` valida somente o feedback observável da fallback
bridge (`Command sent to ...`); isso não prova escrita em PTY, ConPTY, input,
ou execução nativa. O spec não afirma que o comando foi executado pelo
backend Windows.

A UI atual não sinaliza explicitamente uma rotina órfã quando o terminal alvo
deixa de existir: ela conserva e exibe o UUID salvo, mas não mostra badge,
alerta ou filtro de “terminal ausente”. Por isso não há uma asserção de
remoção/órfão neste E2E; esse comportamento permanece uma lacuna de produto,
sem alteração de produção nesta rodada.

## Quality Gate Nativo Determinístico (Windows)

O quality gate nativo backend em Rust (`src-tauri/src/native_harness.rs`) é executado deterministicamente pelo script dedicado `scripts/Invoke-NativeBackendHarness.ps1`.

Quando o toolchain nativo (cargo/Windows) está disponível, o harness valida com componentes reais:
- Criação e execução de múltiplos ConPTYs em paralelo;
- Leitura de output (com verificação exclusiva de echo de input), escrita de input, resize de grid e encerramento limpo via `stop_all`;
- Captura do token `MAESTRI_TOKEN` de dentro do processo ConPTY, validação de credencial por sessão e rejeição de falsificação entre sessões (cross-session spoofing);
- Grafo de autorização e validação de payload/contrato de comandos Maestro (`recruit`, `connect`, `role`, `dismiss`).

No modo padrão (Gate), a falta dos pré-requisitos nativos causa falha explícita (exit 1). Com a flag `-AllowSkip`, o script emite `SKIP` e encerra com código 0.

## Comandos

```powershell
npm run test:e2e
```

Para a verificação nativa backend:

```powershell
.\scripts\Invoke-NativeBackendHarness.ps1 -SelfTest
.\scripts\Invoke-NativeBackendHarness.ps1 -AllowSkip
```
