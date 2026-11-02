---
'@cloudbitmaps/azure-blob': patch
---

A connection string the Azure SDK refuses no longer puts a part of itself in the error: the SDK's reason is shown only when it quotes none of the string's values (the account key and a shared access signature included), and otherwise the message names the parts the string lacks.
