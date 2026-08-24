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

## Lacunas observadas no smoke nativo

`scripts/Invoke-MaestroNativeSmoke.ps1` foi revisado somente em leitura. Ele
faz preparação segura e reproduzível: valida a sintaxe PowerShell, constrói e
verifica app/CLI, testa endpoint loopback e token (incluindo 401 e rejeição de
endpoint não-loopback) e gera um fixture schemaVersion 2 com um terminal
Manager. Os processos de probe iniciados pelo script têm timeout e cleanup
limitado ao próprio script.

O smoke ainda não cobre automaticamente:

- iniciar o executável Tauri e abrir o fixture em uma janela WebView2;
- localizar a janela, clicar em **Abrir…** ou dirigir diálogos de arquivo;
- criar e observar dois ConPTYs reais, incluindo output, input, resize e
  `terminal://exited`;
- confirmar no canvas a sequência nativa recruit → connect → role → dismiss,
  os ACKs, a edge direta, a troca de role e a saída apenas do worker;
- validar no backend o `command` inicial separado de `shellPath` durante o
  recruit real;
- testar screenshot/inspeção visual nativa ou o lifecycle da aplicação.

Depois da preparação, o roteiro manual existente em
`scripts/README-Maestro-Native-Smoke.md` continua necessário: abrir o fixture
no app, executar recruit/connect/role/dismiss no Manager e confirmar o segundo
ConPTY e seu encerramento.

## Comandos

```powershell
npm run test:e2e
```

Para a preparação nativa (fora do Playwright):

```powershell
.\scripts\Invoke-MaestroNativeSmoke.ps1 -SelfTest
.\scripts\Invoke-MaestroNativeSmoke.ps1 -FixturePath (Join-Path $env:TEMP "open-maestri-maestro-native-smoke.json") -ForceFixture
```
