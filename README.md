# Catálogo de plugins Nodivu

Catálogo público **experimental** para testar a loja. Fontes dos plugins são projetos separados:

- [Ducking](https://github.com/Warier/nodivu-ducking)
- [Botão de fala](https://github.com/Warier/nodivu-talk-button)

O aplicativo consulta https://warier.github.io/nodivu-plugins/ . Esse site estático contém
metadados TUF e arquivos verificados; não executa um backend e não recebe seu áudio.
Novos pacotes/versões aparecem sem recompilar o app, desde que sejam compatíveis com seu contrato.
Os dois primeiros pacotes exigem **host_api 2**, posterior à release original Nodivu 0.2.0.
É necessário distribuir uma vez um host com essa capacidade e o bootstrap `source.json`.

## Publicação pelo mantenedor

Node >=22.12, Windows, `npm ci`. `@tufjs/models 4.1.1` serializa e assina os metadados;
o consumidor `tuf-js 5.0.1` valida assinaturas, versões, expiração e hashes.

```powershell
# Uma vez, em pasta PRIVADA fora deste repo (nunca publicar seu conteúdo):
node scripts/publisher.cjs init CAMINHO_PRIVADO
# Compile os dois projetos e depois importe a versão imutável:
node scripts/publisher.cjs add ../nodivu-ducking
node scripts/publisher.cjs add ../nodivu-talk-button
node scripts/publisher.cjs publish CAMINHO_PRIVADO
npm test
# Revise catálogo, fontes, diffs e checksums; commit + push de public/ publica no Pages.
```

O script recusa reutilizar um diretório de versão. Para corrigir um pacote distribuído,
aumente a versão no descriptor/envelope, recompile e importe novamente. README e logo
são copiados do pacote da mesma versão, nunca buscados de uma main mutável.
O selo oficial vem do publicador curado `nodivu`, não de uma declaração do autor.

## Política de assinatura e operação

Quatro chaves Ed25519 distintas (root/targets/snapshot/timestamp), limiar **1 por papel**.
Custódia inicial: mantenedor Warier, assinatura manual local. Esse modelo de teste tem um
único responsável. Apenas a chave de timestamp fica também no secret `STORE_TIMESTAMP_KEY`
do Actions. O publicador Windows usa `publish.dpapi` para targets, snapshot e timestamp.
O bundle de recuperação `keys.dpapi` contém a raiz e só é lido ao provisionar credenciais ou
rotacionar chaves. DPAPI CurrentUser vincula o material local ao usuário/máquina Windows.

Validade: root 365 dias, targets 90 dias, snapshot 30 dias, timestamp **14 dias**.
O Actions verifica diariamente se restam até sete dias de timestamp. Ele valida a cadeia
existente, assina a nova data para o mesmo snapshot e publica no Pages. Se um dos papéis
superiores tiver sete dias ou menos, a automação pede renovação ao mantenedor.
Execute `publish` localmente antes desse ponto (por exemplo, a cada três semanas) e
publique os metadados. Renove também a raiz antes de vencer. O monitor consulta o endereço
público diariamente e acusa falha com até cinco dias restantes. Confira as notificações
dos workflows no GitHub. Se a loja vencer, o cache pode ser consultado.

Para uma instalação antiga, execute `node scripts/publisher.cjs provision-signers CAMINHO_PRIVADO`
uma vez. Após provisionar ou rotacionar, execute `node scripts/publisher.cjs configure-actions CAMINHO_PRIVADO`
com `gh` autenticado em Warier/nodivu-plugins. Esse comando deriva a identidade pública da
credencial, confirma que pertence exclusivamente a timestamp e entrega apenas essa chave
ao GitHub CLI pela entrada padrão. `init` já cria os arquivos separados.
Guarde a recuperação e o backup offline sob controle do mantenedor. Copiar um arquivo
DPAPI para outro PC por si só não garante recuperação.

### Rotação / recuperação

```powershell
node scripts/publisher.cjs rotate CAMINHO_PRIVADO
npm test
```

Rotação cria quatro chaves novas, publica root N+1 assinada pela raiz antiga e nova e
reassina os metadados. Preserve todas as `N.root.json` para clientes antigos avançarem.
O bootstrap source.json mantém a primeira raiz; não substitua silenciosamente a confiança.
Chaves antigas permanecem criptografadas como backup de operação; não reutilizá-las para
novas versões após a rotação. A operação exige as chaves atuais; se forem perdidas antes
sem backup utilizável, será preciso novo bootstrap em uma atualização do aplicativo.
Em falha no meio da rotação, não faça push: restaure conjuntamente chaves e metadados do
backup/revisão anterior e repita. Não restaure versões já publicadas nem rebaixe contador.

### Retirar um pacote

Remova o item de catalog.json, execute publish e faça commit/push. Preserve targets antigos
para coerência/cache. Isso impede novas instalações pela lista; **não desativa DLLs já
instaladas**. Revogação/quarentena remota no cliente é trabalho futuro. Se uma chave for
comprometida, audite artefatos, rotacione e publique avisos; não basta apagar um ZIP.

## Hospedagem

GitHub Pages, branch main, pasta /public configurada via workflow que publica somente public/.
Deploy atômico: targets/metadados são enviados juntos. A chave privada não participa do deploy.
Também é possível hospedar essa pasta em HTTPS estático sem redirecionamentos.

## Testes e limites

`npm test` usa chaves efêmeras e o cliente TUF real para testar assinatura, atualização de
catálogo, rotação e rejeição de conteúdo adulterado. Não carrega DLLs. O Nodivu contém ensaios
separados para instalação real e áudio dos dois plugins. `host_api 2` cobre segunda entrada
CLAP e gesto momentâneo; pacotes exigem Windows x64. DLLs não têm sandbox.

Referências: [TUF](https://theupdateframework.github.io/specification/latest/),
[contrato do Nodivu](https://github.com/Warier/nodivu/blob/main/PLUGIN-STORE.md).
Código MIT; cada plugin mantém sua própria licença.
