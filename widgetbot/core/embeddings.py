import os
import threading
import torch
import torch.nn.functional as F

# OpenVINO imports
try:
    from transformers import AutoTokenizer
    from optimum.intel.openvino import OVModelForFeatureExtraction
except ImportError:
    print("WARNING: optimum-intel or openvino not installed. Embeddings will fail.")

OV_DIR = "all-MiniLM-L6-v2-ov-fp16"
MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2'
EMBEDDING_DIM = 384

# Setup OpenVINO Embedding Model (shared by FAQ routing, RAG retrieval and the crawler)
print("Setting up OpenVINO embedding model...")
if not os.path.exists(OV_DIR):
    # Try looking in parent directory (where testEmbed.py exported it)
    if os.path.exists("../" + OV_DIR):
        OV_DIR = "../" + OV_DIR
    else:
        print(f"Exporting {MODEL_ID} to OpenVINO FP16 format...")
        os.system(f"optimum-cli export openvino --model {MODEL_ID} --weight-format fp16 {OV_DIR}")

ov_tokenizer = AutoTokenizer.from_pretrained(OV_DIR)
ov_model = OVModelForFeatureExtraction.from_pretrained(OV_DIR)
# The model has one inference request; a dashboard crawl (worker thread) and chat replies must take turns
_model_lock = threading.Lock()

def get_ov_embedding(sentences):
    inputs = ov_tokenizer(sentences, padding=True, truncation=True, return_tensors="pt")
    with _model_lock:
        outputs = ov_model(**inputs)
    attention_mask = inputs['attention_mask']
    token_embeddings = outputs.last_hidden_state
    input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, 1)
    sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
    embeddings = sum_embeddings / sum_mask
    return F.normalize(embeddings, p=2, dim=1)
