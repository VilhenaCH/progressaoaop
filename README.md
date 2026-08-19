# Nexo — Terminal de Progressão

Terminal web para o servidor de RPG: cadastro de personagens, acompanhamento de PE/PP,
solicitações de resgate e painel de staff. Um único `index.html`, sem build — hospeda
direto no GitHub Pages.

## 1. Ativar o Google Sign-In no Firebase

1. No [Console do Firebase](https://console.firebase.google.com/), abra o projeto `progressao-nexo`.
2. Vá em **Authentication → Sign-in method** e ative o provedor **Google**.
3. Em **Authentication → Settings → Authorized domains**, adicione o domínio onde o
   GitHub Pages vai publicar o site (ex: `seuusuario.github.io`).

## 2. Criar o Firestore

1. Vá em **Firestore Database → Criar banco de dados** (modo produção).
2. Não precisa criar coleções manualmente — o app cria `players`, `players/{uid}/characters`,
   `redemptions` e `grants` sozinho conforme o uso.

## 3. Descobrir seu UID e virar staff

1. Publique o site (passo 5) e faça login com sua conta Google normalmente.
2. Abra o console do navegador (F12) — o app imprime `Seu UID (caso precise virar staff): ...`
   assim que você loga sem ser admin.
3. Copie esse UID e cole em **dois lugares**:
   - `index.html`, dentro de `ADMIN_UIDS` (procure por `cole_seu_uid_aqui`);
   - `firestore.rules`, dentro da função `isAdmin()` (mesmo texto `cole_seu_uid_aqui`).
4. Publique de novo o `firestore.rules` (passo 4) e o `index.html` atualizado.

> Os dois lugares precisam ter a mesma lista. O array no `index.html` só controla o que
> aparece na tela (mostrar ou não a aba Staff); quem realmente impede um jogador comum
> de aprovar resgates ou editar PP é o `firestore.rules`.

## 4. Publicar as regras do Firestore

Com a [Firebase CLI](https://firebase.google.com/docs/cli) instalada:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # selecione o projeto progressao-nexo, aceite o firestore.rules existente
firebase deploy --only firestore:rules
```

Ou cole o conteúdo de `firestore.rules` direto em **Firestore Database → Regras** no
Console e clique em **Publicar**.

## 5. Hospedar no GitHub Pages

1. Crie um repositório novo e suba os três arquivos (`index.html`, `firestore.rules`,
   este `README.md`).
2. Em **Settings → Pages**, escolha a branch `main` e a pasta raiz (`/`).
3. O site fica disponível em `https://seuusuario.github.io/nome-do-repo/`.
4. Não esqueça de voltar no passo 1 e adicionar esse domínio em Authorized domains.

## Como o sistema funciona

- **Players**: fazem login com Google, cadastram personagens, acompanham PE/nível/patente
  e o teto de gasto de Prestígio (PP total ÷ personagens ativos). Podem abrir solicitações
  de conversão de PP em PE, aquisição de patente, compra na loja ou outros resgates —
  e cancelar enquanto estiverem pendentes (não dá pra editar depois de enviada).
- **Staff** (UIDs em `ADMIN_UIDS`): vê a fila de solicitações pendentes e aprova/nega —
  ao aprovar, o PE/PP é aplicado automaticamente ao jogador/personagem. Também pode
  conceder PE e PP customizados a qualquer jogador/personagem diretamente (ex: depois de
  uma sessão), com a opção de marcar isso como "sessão jogada" para destravar o limite de
  conversões daquele personagem.

## Limites já calculados automaticamente

- Progressão de nível (PE cumulativo por nível, conforme a tabela do servidor).
- Teto de gasto de Prestígio: `PP total ÷ personagens ativos`, excluindo quem está em
  Evolução Máxima da Temporada.
- Limite de 1 conversão de PP→PE e 1 PE de narração por sessão jogada.
- Requisitos de nível + PP para cada patente.

## Coisas que ficaram como decisão manual da staff (por enquanto)

- Marcar um personagem como "Evolução Máxima da Temporada" (nível 8 / NEX 40% na
  Temporada 1) ainda é feito direto no Firestore, editando o campo `seasonMaxed` do
  documento do personagem — não tem botão na tela ainda.
- O parâmetro da temporada vigente (`SEASON` no topo do `index.html`) é ajustado manualmente
  a cada nova temporada.
