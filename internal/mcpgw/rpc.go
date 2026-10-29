package mcpgw

import (
	"encoding/json"
	"fmt"
)

// protocolVersion is what VVTerm speaks to servers and offers to agents.
const protocolVersion = "2025-03-26"

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message) }

func reply(id json.RawMessage, result any) []byte {
	b, _ := json.Marshal(result)
	out, _ := json.Marshal(rpcMsg{JSONRPC: "2.0", ID: id, Result: b})
	return out
}

func replyErr(id json.RawMessage, code int, msg string) []byte {
	out, _ := json.Marshal(rpcMsg{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}})
	return out
}

type toolWire struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Annotations struct {
		ReadOnlyHint bool `json:"readOnlyHint"`
	} `json:"annotations"`
}

type callResultWire struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	IsError bool `json:"isError"`
}
