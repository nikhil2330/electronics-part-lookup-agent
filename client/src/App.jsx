import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Cpu,
  Database,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  SendHorizontal,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000'
).replace(/\/+$/, '')
const LYZR_CHAT_URL = `${API_BASE_URL}/api/lyzr-chat`
const CHATS_KEY = 'electronics-part-agent-chats'
const ACTIVE_CHAT_KEY = 'electronics-part-agent-active-chat-id'
const LEGACY_SESSION_KEY = 'electronics-part-agent-session-id'
const LEGACY_MESSAGES_KEY = 'electronics-part-agent-messages'
const MAX_CHATS = 12
const MAX_MESSAGES_PER_CHAT = 40

const quickPrompts = [
  'What is LM358?',
  'Find a logic level MOSFET',
  'Compare Mouser and DigiKey for ESP32-WROOM-32',
  'What is the capacitance of GRM188R71H104KA93D?',
  'Check these parts: LM358, SEN0466, ESP32-WROOM-32',
]

const starterMessages = [
  {
    id: 'welcome',
    role: 'assistant',
    content:
      'Ready. Send a part number, supplier search, comparison, or follow-up question.',
  },
]

function cloneStarterMessages() {
  return starterMessages.map((message) => ({ ...message }))
}

const labelMap = {
  manufacturer: 'manufacturer',
  'manufacturer part number': 'manufacturerPart',
  'mfr part': 'manufacturerPart',
  'mfr part number': 'manufacturerPart',
  'mouser part number': 'mouserPart',
  'mouser part': 'mouserPart',
  'digikey part number': 'digikeyPart',
  'digikey part': 'digikeyPart',
  category: 'category',
  description: 'description',
  stock: 'availability',
  availability: 'availability',
  'lead time': 'leadTime',
  'first price': 'price',
  price: 'price',
  status: 'status',
  'datasheet available': 'datasheet',
  datasheet: 'datasheet',
  'product page available': 'productPage',
  'product page': 'productPage',
}

const productFieldLabels = {
  manufacturer: 'Manufacturer',
  manufacturerPart: 'Mfr Part',
  mouserPart: 'Mouser Part',
  digikeyPart: 'DigiKey Part',
  category: 'Category',
  availability: 'Availability',
  leadTime: 'Lead Time',
  price: 'Price',
  status: 'Status',
  datasheet: 'Datasheet',
  productPage: 'Product Page',
}

function stripMarkdown(value) {
  return value
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

function compact(value, maxLength = 1200) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trim()}...`
}

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isValidMessage(message) {
  return (
    typeof message?.id === 'string' &&
    ['user', 'assistant'].includes(message?.role) &&
    typeof message?.content === 'string'
  )
}

function sanitizeMessages(messages) {
  const clean = Array.isArray(messages) ? messages.filter(isValidMessage) : []
  return clean.length ? clean.slice(-MAX_MESSAGES_PER_CHAT) : cloneStarterMessages()
}

function deriveChatTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (!firstUserMessage) return 'New chat'
  return compact(firstUserMessage.content, 56)
}

function createChat(overrides = {}) {
  const now = Date.now()
  const messages = sanitizeMessages(overrides.messages)

  return {
    id: typeof overrides.id === 'string' ? overrides.id : makeId('chat'),
    title:
      typeof overrides.title === 'string' && overrides.title.trim()
        ? compact(overrides.title, 56)
        : deriveChatTitle(messages),
    sessionId:
      typeof overrides.sessionId === 'string' ? overrides.sessionId.trim() : '',
    messages,
    createdAt:
      typeof overrides.createdAt === 'number' ? overrides.createdAt : now,
    updatedAt:
      typeof overrides.updatedAt === 'number' ? overrides.updatedAt : now,
  }
}

function getLegacyMessages() {
  try {
    return sanitizeMessages(JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) ?? 'null'))
  } catch {
    return cloneStarterMessages()
  }
}

function getLegacySessionId() {
  try {
    return localStorage.getItem(LEGACY_SESSION_KEY) ?? ''
  } catch {
    return ''
  }
}

function getStoredChats() {
  try {
    const stored = JSON.parse(localStorage.getItem(CHATS_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.length) {
      const chats = stored
        .filter((chat) => chat && typeof chat === 'object')
        .map((chat) =>
          createChat({
            id: chat.id,
            title: chat.title,
            sessionId: chat.sessionId,
            messages: chat.messages,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
          }),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHATS)

      if (chats.length) return chats
    }
  } catch {
    // Fall back to the older single-chat storage format below.
  }

  const legacyMessages = getLegacyMessages()
  return [
    createChat({
      sessionId: getLegacySessionId(),
      messages: legacyMessages,
      title: deriveChatTitle(legacyMessages),
    }),
  ]
}

function saveChats(chats) {
  try {
    const payload = chats.slice(0, MAX_CHATS).map((chat) => ({
      ...chat,
      title: compact(chat.title || deriveChatTitle(chat.messages), 56),
      messages: sanitizeMessages(chat.messages),
    }))

    localStorage.setItem(CHATS_KEY, JSON.stringify(payload))
  } catch {
    // The app still works if storage is unavailable.
  }
}

function getStoredActiveChatId() {
  try {
    return localStorage.getItem(ACTIVE_CHAT_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveActiveChatId(chatId) {
  try {
    localStorage.setItem(ACTIVE_CHAT_KEY, chatId)
  } catch {
    // Ignore storage failures.
  }
}

function getInitialChatState() {
  const chats = getStoredChats()
  const storedActiveChatId = getStoredActiveChatId()
  const activeChatId = chats.some((chat) => chat.id === storedActiveChatId)
    ? storedActiveChatId
    : chats[0]?.id || ''

  return { chats, activeChatId }
}

function countUserMessages(messages) {
  return messages.filter((message) => message.role === 'user').length
}

function formatChatMeta(chat) {
  const asks = countUserMessages(chat.messages)
  const askLabel = asks === 1 ? 'ask' : 'asks'
  return `${asks} ${askLabel}${chat.sessionId ? ' · saved session' : ''}`
}

function parseKeyValue(line) {
  const clean = stripMarkdown(line)
  const match = clean.match(/^([^:]{2,46}):\s*(.+)$/)
  if (!match) return null

  const rawLabel = match[1].toLowerCase().replace(/\s+/g, ' ').trim()
  const key = labelMap[rawLabel]

  if (!key) return null

  return {
    key,
    label: productFieldLabels[key],
    value: match[2].trim(),
  }
}

function hasProductSignal(lines) {
  return lines.some((line) => parseKeyValue(line))
}

function splitProductBlocks(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const blocks = []
  let current = []

  for (const line of lines) {
    const clean = stripMarkdown(line)
    const startsNewProduct =
      /^(top match|best match(?:\s+on\s+[^:]+)?|other result|alternative|result\s+\d+)/i.test(
        clean,
      )

    if (startsNewProduct && current.length && hasProductSignal(current)) {
      blocks.push(current)
      current = []
    }

    current.push(line)
  }

  if (current.length) {
    blocks.push(current)
  }

  return blocks
}

function parseProductBlock(lines) {
  const fields = {}
  let title = ''
  let sectionTitle = ''

  for (const line of lines) {
    const clean = stripMarkdown(line)
    const headingMatch = clean.match(
      /^(top match|best match(?:\s+on\s+[^:]+)?|other result|alternative|result\s+\d+)\s*:?\s*(.*)$/i,
    )

    if (headingMatch) {
      sectionTitle = headingMatch[1]
      if (headingMatch[2]) {
        title = headingMatch[2].trim()
      }
      continue
    }

    const parsed = parseKeyValue(line)
    if (parsed) {
      fields[parsed.key] = parsed.value
      continue
    }

    if (!title && sectionTitle && clean.length > 3 && clean.length < 120) {
      title = clean
    }
  }

  const primaryPart =
    fields.manufacturerPart || fields.digikeyPart || fields.mouserPart || ''

  if (!title && fields.manufacturer && primaryPart) {
    title = `${fields.manufacturer} ${primaryPart}`
  } else if (!title) {
    title = primaryPart || fields.description || ''
  }

  const fieldCount = Object.values(fields).filter(Boolean).length
  if (!title || fieldCount < 2) return null

  const supplier = fields.digikeyPart
    ? 'DigiKey'
    : fields.mouserPart
      ? 'Mouser'
      : sectionTitle || 'Product'

  return {
    id: `${title}-${fields.mouserPart ?? ''}-${fields.digikeyPart ?? ''}`,
    title,
    supplier,
    description: fields.description ?? '',
    fields,
  }
}

function parseProductCards(content) {
  return splitProductBlocks(content)
    .map(parseProductBlock)
    .filter(Boolean)
    .slice(0, 4)
}

function getLatestProductCards(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'assistant') continue

    const cards = parseProductCards(messages[index].content)
    if (cards.length) return cards
  }

  return []
}

function buildHistory(messages) {
  return messages
    .filter((message) => message.id !== 'welcome')
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: compact(message.content, 1400),
    }))
}

function findLastUserRequest(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content
  }

  return ''
}

function findLastSearchIntent(messages) {
  const intentPattern =
    /\b(find|search|lookup|compare|details|product|mouser|digikey|rpm|motor|mosfet|capacitor|resistor|sensor|esp32|lm358)\b/i

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && intentPattern.test(message.content)) {
      return message.content
    }
  }

  return findLastUserRequest(messages)
}

function buildCardSummary(card) {
  const fields = [
    card.title,
    card.fields.manufacturer && `Manufacturer: ${card.fields.manufacturer}`,
    card.fields.manufacturerPart && `Mfr part: ${card.fields.manufacturerPart}`,
    card.fields.mouserPart && `Mouser part: ${card.fields.mouserPart}`,
    card.fields.digikeyPart && `DigiKey part: ${card.fields.digikeyPart}`,
    card.fields.category && `Category: ${card.fields.category}`,
    card.fields.description && `Description: ${card.fields.description}`,
    card.fields.availability && `Availability: ${card.fields.availability}`,
    card.fields.price && `Price: ${card.fields.price}`,
    card.fields.status && `Status: ${card.fields.status}`,
  ].filter(Boolean)

  return fields.join(' | ')
}

function buildActiveContext(messages, currentMessage) {
  const latestCards = getLatestProductCards(messages)
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.id !== 'welcome')

  const productSummary = latestCards.length
    ? latestCards.map(buildCardSummary).join('\n')
    : latestAssistant?.content
      ? compact(latestAssistant.content, 1800)
      : ''

  const candidates = latestCards.flatMap((card) =>
    [
      card.title,
      card.fields.manufacturerPart,
      card.fields.mouserPart,
      card.fields.digikeyPart,
    ].filter(Boolean),
  )

  const combinedText = `${currentMessage} ${productSummary}`
  const lastSupplier = /digikey/i.test(combinedText)
    ? 'DigiKey'
    : /mouser/i.test(combinedText)
      ? 'Mouser'
      : ''

  return {
    last_user_request: findLastUserRequest(messages),
    last_search_intent: findLastSearchIntent(messages),
    last_supplier: lastSupplier || undefined,
    product_summary: productSummary || undefined,
    candidates: candidates.length ? [...new Set(candidates)].slice(0, 8) : undefined,
  }
}

function nextMessageId(messages, role) {
  const contentSize = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  )

  return `${role}-${messages.length}-${contentSize}`
}

function ProductCard({ card, compactView = false }) {
  const fieldEntries = [
    'manufacturer',
    'manufacturerPart',
    'mouserPart',
    'digikeyPart',
    'category',
    'availability',
    'leadTime',
    'price',
    'status',
    'datasheet',
    'productPage',
  ]
    .map((key) => ({
      key,
      label: productFieldLabels[key],
      value: card.fields[key],
    }))
    .filter((field) => field.value)

  return (
    <article className={`product-card ${compactView ? 'compact' : ''}`}>
      <div className="product-card-header">
        <span className="supplier-badge">{card.supplier}</span>
        <Database size={16} aria-hidden="true" />
      </div>
      <h3>{card.title}</h3>
      {card.description && <p className="product-description">{card.description}</p>}
      <dl>
        {fieldEntries.map((field) => (
          <div key={field.key}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

function MessageBubble({ message }) {
  const productCards =
    message.role === 'assistant' ? parseProductCards(message.content) : []

  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === 'user' ? <UserRound size={18} /> : <Bot size={18} />}
      </div>
      <div className="message-stack">
        <div className="message-label">
          {message.role === 'user' ? 'You' : 'Agent'}
        </div>
        {productCards.length > 0 && (
          <div className="product-card-grid">
            {productCards.map((card) => (
              <ProductCard card={card} key={card.id} />
            ))}
          </div>
        )}
        <div className="message-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </article>
  )
}

function App() {
  const [initialChatState] = useState(getInitialChatState)
  const [chats, setChats] = useState(initialChatState.chats)
  const [activeChatId, setActiveChatId] = useState(initialChatState.activeChatId)
  const [input, setInput] = useState('')
  const [sendingChatId, setSendingChatId] = useState('')
  const [error, setError] = useState('')
  const messagesEndRef = useRef(null)

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId),
    [chats, activeChatId],
  )
  const activeChat = selectedChat ?? chats[0]
  const messages = activeChat?.messages ?? cloneStarterMessages()
  const sessionId = activeChat?.sessionId ?? ''
  const isSending = Boolean(sendingChatId)
  const isActiveChatSending = sendingChatId === activeChat?.id

  const latestProductCards = useMemo(() => getLatestProductCards(messages), [messages])
  const activeContext = useMemo(
    () => buildActiveContext(messages, input),
    [messages, input],
  )

  useEffect(() => {
    saveChats(chats)
  }, [chats])

  useEffect(() => {
    if (activeChat?.id) {
      saveActiveChatId(activeChat.id)
    }
  }, [activeChat?.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeChat?.id, messages.length, sendingChatId])

  function updateChat(chatId, updater) {
    setChats((current) =>
      current
        .map((chat) => {
          if (chat.id !== chatId) return chat

          const nextChat = updater(chat)
          return {
            ...nextChat,
            messages: sanitizeMessages(nextChat.messages),
            title: compact(nextChat.title || deriveChatTitle(nextChat.messages), 56),
            updatedAt: Date.now(),
          }
        })
        .sort((a, b) => {
          if (a.id === activeChatId) return -1
          if (b.id === activeChatId) return 1
          return b.updatedAt - a.updatedAt
        })
        .slice(0, MAX_CHATS),
    )
  }

  function startNewChat() {
    const nextChat = createChat()
    setChats((current) => [nextChat, ...current].slice(0, MAX_CHATS))
    setActiveChatId(nextChat.id)
    setInput('')
    setError('')
  }

  function selectChat(chatId) {
    setActiveChatId(chatId)
    setInput('')
    setError('')
  }

  function deleteChat(chatId) {
    if (sendingChatId === chatId) return

    const remainingChats = chats.filter((chat) => chat.id !== chatId)
    const nextChats = remainingChats.length ? remainingChats : [createChat()]

    setChats((current) => {
      const remaining = current.filter((chat) => chat.id !== chatId)
      return remaining.length ? remaining : nextChats
    })

    if (activeChatId === chatId || !remainingChats.length) {
      setActiveChatId(nextChats[0].id)
    }
  }

  async function sendMessage(nextMessage = input) {
    const text = nextMessage.trim()
    if (!text || isSending || !activeChat) return

    const targetChatId = activeChat.id
    const previousMessages = activeChat.messages
    const userMessage = {
      id: nextMessageId(previousMessages, 'user'),
      role: 'user',
      content: text,
    }

    updateChat(targetChatId, (chat) => ({
      ...chat,
      title: chat.title === 'New chat' ? deriveChatTitle([...previousMessages, userMessage]) : chat.title,
      messages: [...chat.messages, userMessage],
    }))
    setInput('')
    setError('')
    setSendingChatId(targetChatId)

    try {
      const response = await fetch(LYZR_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          session_id: activeChat.sessionId || undefined,
          history: buildHistory(previousMessages),
          active_context: buildActiveContext(previousMessages, text),
        }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.error || `Request failed with ${response.status}`)
      }

      updateChat(targetChatId, (chat) => {
        const assistantMessage = {
          id: nextMessageId(chat.messages, 'assistant'),
          role: 'assistant',
          content: data.reply || 'I received a response, but it was empty.',
        }

        return {
          ...chat,
          sessionId: data.session_id || chat.sessionId,
          messages: [...chat.messages, assistantMessage],
        }
      })
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Something went wrong while contacting the backend.'

      setError(message)
      updateChat(targetChatId, (chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: nextMessageId(chat.messages, 'error'),
            role: 'assistant',
            content: `I could not complete that request: ${message}`,
          },
        ],
      }))
    } finally {
      setSendingChatId('')
    }
  }

  function handleSubmit(event) {
    event.preventDefault()
    sendMessage()
  }

  function resetSession() {
    if (!activeChat) return

    updateChat(activeChat.id, (chat) => ({
      ...chat,
      title: 'New chat',
      sessionId: '',
      messages: cloneStarterMessages(),
    }))
    setError('')
    setInput('')
  }

  return (
    <main className="app-shell">
      <header className="topbar" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <Cpu size={24} />
        </div>
        <div className="brand-copy">
          <p className="eyebrow">Mouser + DigiKey + Lyzr</p>
          <h1 id="app-title">Electronics Part Intelligence Agent</h1>
          <p className="subtitle">
            Search Mouser and DigiKey with a Lyzr-powered AI assistant
          </p>
        </div>
        <div className="session-panel" aria-label="Current chat session">
          <span className="status-dot" aria-hidden="true" />
          <span>{sessionId ? 'Session active' : 'New session'}</span>
          <button type="button" onClick={resetSession} title="Reset current chat">
            <RotateCcw size={16} aria-hidden="true" />
            Reset
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="side-rail" aria-label="Search controls">
          <section className="rail-section chat-window-section">
            <div className="rail-heading">
              <MessageSquare size={16} aria-hidden="true" />
              <h2>Chat Windows</h2>
            </div>
            <button
              className="new-chat-button"
              type="button"
              onClick={startNewChat}
              disabled={isSending}
            >
              <Plus size={16} aria-hidden="true" />
              New chat
            </button>
            <div className="chat-list">
              {chats.map((chat) => (
                <div
                  className={`chat-window-row ${chat.id === activeChat?.id ? 'active' : ''}`}
                  key={chat.id}
                >
                  <button
                    className="chat-window-button"
                    type="button"
                    onClick={() => selectChat(chat.id)}
                    aria-current={chat.id === activeChat?.id ? 'true' : undefined}
                  >
                    <MessageSquare size={15} aria-hidden="true" />
                    <span className="chat-window-copy">
                      <span>{chat.title}</span>
                      <small>{formatChatMeta(chat)}</small>
                    </span>
                  </button>
                  <button
                    className="delete-chat-button"
                    type="button"
                    onClick={() => deleteChat(chat.id)}
                    disabled={chats.length === 1 || sendingChatId === chat.id}
                    title="Delete chat"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="rail-section">
            <div className="rail-heading">
              <Search size={16} aria-hidden="true" />
              <h2>Quick Prompts</h2>
            </div>
            <div className="prompt-list">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => sendMessage(prompt)}
                  disabled={isSending}
                >
                  <Sparkles size={15} aria-hidden="true" />
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="rail-section context-section">
            <div className="rail-heading">
              <Database size={16} aria-hidden="true" />
              <h2>Active Context</h2>
            </div>
            {latestProductCards.length ? (
              <div className="context-card-list">
                {latestProductCards.slice(0, 2).map((card) => (
                  <ProductCard card={card} compactView key={card.id} />
                ))}
              </div>
            ) : (
              <p className="empty-context">
                {activeContext.last_search_intent || 'No part selected yet.'}
              </p>
            )}
          </section>
        </aside>

        <section className="conversation-panel" aria-label="Chat history">
          <div className="conversation-toolbar">
            <div>
              <h2>{activeChat?.title ?? 'Conversation'}</h2>
              <p>
                {sessionId
                  ? 'This chat has its own saved Lyzr context'
                  : 'A new Lyzr session starts with your next message'}
              </p>
            </div>
            <span>{countUserMessages(messages)} asks</span>
          </div>

          <div className="messages">
            {messages.map((message) => (
              <MessageBubble message={message} key={message.id} />
            ))}

            {isActiveChatSending && (
              <article className="message assistant">
                <div className="message-avatar" aria-hidden="true">
                  <Bot size={18} />
                </div>
                <div className="message-stack">
                  <div className="message-label">Agent</div>
                  <div className="message-content thinking">
                    <span />
                    <p>Checking the active part context...</p>
                  </div>
                </div>
              </article>
            )}

            <div ref={messagesEndRef} />
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  sendMessage()
                }
              }}
              placeholder="Ask about a part number, supplier match, or specs..."
              rows={2}
              disabled={isSending}
            />
            <button type="submit" disabled={isSending || !input.trim()}>
              <SendHorizontal size={18} aria-hidden="true" />
              Send
            </button>
          </form>

          {error && <p className="error-message">{error}</p>}
        </section>
      </div>
    </main>
  )
}

export default App
