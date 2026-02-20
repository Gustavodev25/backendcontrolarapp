# ControlarApp - Server Backend

Servidor backend para integração com a API Pluggy (Open Finance).

## Setup

### 1. Instalar dependências

```bash
# Na pasta raiz do projeto
npm run server:install

# Ou diretamente na pasta server
cd server && npm install
```

### 2. Configurar credenciais

Edite o arquivo `server/.env` com suas credenciais da Pluggy:

```env
PLUGGY_CLIENT_ID=seu_client_id_aqui
PLUGGY_CLIENT_SECRET=seu_client_secret_aqui
PLUGGY_SANDBOX=true
PORT=3001
```

**Obtenha suas credenciais em:** https://dashboard.pluggy.ai

`PLUGGY_SANDBOX` controla qual base de conectores o backend consulta:
- `true`: ambiente de teste (sandbox)
- `false`: ambiente de producao

### 3. Executar

#### Opção 1: Iniciar tudo junto (Expo + Servidor)
```bash
npm run dev
```

#### Opção 2: Iniciar separadamente
```bash
# Terminal 1 - Servidor
npm run server:dev

# Terminal 2 - Expo
npm start
```

## Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia Expo + Servidor simultaneamente |
| `npm run dev:android` | Inicia Expo (Android) + Servidor |
| `npm run dev:ios` | Inicia Expo (iOS) + Servidor |
| `npm run dev:web` | Inicia Expo (Web) + Servidor |
| `npm run server` | Inicia apenas o servidor |
| `npm run server:dev` | Inicia servidor com hot-reload |
| `npm run server:install` | Instala dependências do servidor |

## Endpoints da API

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/health` | Health check |
| GET | `/api/pluggy/connectors` | Lista bancos disponíveis |
| POST | `/api/pluggy/create-item` | Cria conexão com banco |
| GET | `/api/pluggy/items/:id` | Status da conexão |
| POST | `/api/pluggy/sync` | Sincroniza contas/transações |
| DELETE | `/api/pluggy/items/:id` | Remove conexão |
| POST | `/api/pluggy/update-item/:id` | Atualiza dados da conexão |

## Testando com dispositivo físico

Se estiver testando com um dispositivo físico (não emulador), você precisará:

1. **Descobrir seu IP local:**
   ```bash
   # Windows
   ipconfig
   
   # Mac/Linux
   ifconfig
   ```

2. **Configurar a URL da API no app** criando `/.env.local` na raiz do projeto:
   ```env
   EXPO_PUBLIC_API_URL=http://SEU_IP_LOCAL:3001
   ```

3. **Garantir que o dispositivo está na mesma rede WiFi**

> Observacao: em producao, se `EXPO_PUBLIC_API_URL` nao estiver definida, o app usa como fallback `https://controlar-production.up.railway.app`.

## Usando ngrok (para testes externos)

Se precisar expor o servidor para a internet:

```bash
ngrok http 3001
```

Atualize `EXPO_PUBLIC_API_URL` com a URL do ngrok gerada.
