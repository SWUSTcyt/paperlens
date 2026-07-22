"""用作者 HTML 公式作人工参考，在 PDF 中定位编号锚点并生成待复核金标与裁剪图。"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import posixpath
import re
import tarfile
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageDraw


QUOTAS = {
    "1706.03762": 2,
    "1412.6980": 6,
    "2006.11239": 7,
    "1312.6114": 6,
    "1512.03385": 2,
    "1502.03167": 0,
    "1607.06450": 6,
    "1810.04805": 0,
    "2106.09685": 4,
    "1312.5602": 3,
    "1406.2661": 5,
    "1707.06347": 7,
    "1806.07366": 12,
}

CORE = {
    ("1706.03762", "1"),
    ("1706.03762", "2"),
    ("1512.03385", "1"),
    ("1512.03385", "2"),
}

TWO_COLUMN = {
    "1512.03385",
    "1502.03167",
    "1607.06450",
    "1810.04805",
    "1312.5602",
    "1406.2661",
    "1806.07366",
}

# 自动编号定位只负责给人工标注提供起点。下面这些覆盖项是逐页核对后的冻结
# 金标：修正两栏长公式的截断、正文中的 “Eq. (n)” 假锚点，并把作者宏
# 展开为可由通用 KaTeX 解析的 LaTeX。坐标为左上原点、0–1000 归一化。
OVERRIDES = {
    # Adam
    ("1412.6980", "1"): {"latex": r"v_t=(1-\beta_2)\sum_{i=1}^{t}\beta_2^{t-i}g_i^2"},
    ("1412.6980", "2"): {"latex": r"\mathbb{E}[v_t]=\mathbb{E}\left[(1-\beta_2)\sum_{i=1}^{t}\beta_2^{t-i}g_i^2\right]"},
    ("1412.6980", "3"): {"latex": r"=\mathbb{E}[g_t^2](1-\beta_2)\sum_{i=1}^{t}\beta_2^{t-i}+\zeta"},
    ("1412.6980", "4"): {"latex": r"=\mathbb{E}[g_t^2](1-\beta_2^t)+\zeta"},
    ("1412.6980", "5"): {"latex": r"R(T)=\sum_{t=1}^{T}\left[f_t(\theta_t)-f_t(\theta^*)\right]"},
    ("1412.6980", "6"): {"latex": r"v_t=\beta_2^p v_{t-1}+(1-\beta_2^p)|g_t|^p"},
    # DDPM
    ("2006.11239", "1"): {"latex": r"p_\theta(\mathbf{x}_{0:T})=p(\mathbf{x}_T)\prod_{t=1}^{T}p_\theta(\mathbf{x}_{t-1}\mid\mathbf{x}_t),\quad p_\theta(\mathbf{x}_{t-1}\mid\mathbf{x}_t)=\mathcal{N}(\mathbf{x}_{t-1};\boldsymbol{\mu}_\theta(\mathbf{x}_t,t),\boldsymbol{\Sigma}_\theta(\mathbf{x}_t,t))"},
    ("2006.11239", "2"): {"latex": r"q(\mathbf{x}_{1:T}\mid\mathbf{x}_0)=\prod_{t=1}^{T}q(\mathbf{x}_t\mid\mathbf{x}_{t-1}),\quad q(\mathbf{x}_t\mid\mathbf{x}_{t-1})=\mathcal{N}(\mathbf{x}_t;\sqrt{1-\beta_t}\mathbf{x}_{t-1},\beta_t\mathbf{I})"},
    ("2006.11239", "3"): {"latex": r"\mathbb{E}[-\log p_\theta(\mathbf{x}_0)]\leq\mathbb{E}_q\left[-\log\frac{p_\theta(\mathbf{x}_{0:T})}{q(\mathbf{x}_{1:T}\mid\mathbf{x}_0)}\right]=\mathbb{E}_q\left[-\log p(\mathbf{x}_T)-\sum_{t\geq1}\log\frac{p_\theta(\mathbf{x}_{t-1}\mid\mathbf{x}_t)}{q(\mathbf{x}_t\mid\mathbf{x}_{t-1})}\right]=L"},
    ("2006.11239", "4"): {"latex": r"q(\mathbf{x}_t\mid\mathbf{x}_0)=\mathcal{N}(\mathbf{x}_t;\sqrt{\bar{\alpha}_t}\mathbf{x}_0,(1-\bar{\alpha}_t)\mathbf{I})"},
    ("2006.11239", "5"): {"latex": r"\mathbb{E}_q\left[D_{\mathrm{KL}}(q(\mathbf{x}_T\mid\mathbf{x}_0)\Vert p(\mathbf{x}_T))+\sum_{t>1}D_{\mathrm{KL}}(q(\mathbf{x}_{t-1}\mid\mathbf{x}_t,\mathbf{x}_0)\Vert p_\theta(\mathbf{x}_{t-1}\mid\mathbf{x}_t))-\log p_\theta(\mathbf{x}_0\mid\mathbf{x}_1)\right]"},
    ("2006.11239", "6"): {"latex": r"q(\mathbf{x}_{t-1}\mid\mathbf{x}_t,\mathbf{x}_0)=\mathcal{N}(\mathbf{x}_{t-1};\tilde{\boldsymbol{\mu}}_t(\mathbf{x}_t,\mathbf{x}_0),\tilde{\beta}_t\mathbf{I})", "bbox": [180, 205, 840, 260]},
    ("2006.11239", "7"): {"latex": r"\tilde{\boldsymbol{\mu}}_t(\mathbf{x}_t,\mathbf{x}_0)=\frac{\sqrt{\bar{\alpha}_{t-1}}\beta_t}{1-\bar{\alpha}_t}\mathbf{x}_0+\frac{\sqrt{\alpha_t}(1-\bar{\alpha}_{t-1})}{1-\bar{\alpha}_t}\mathbf{x}_t,\quad\tilde{\beta}_t=\frac{1-\bar{\alpha}_{t-1}}{1-\bar{\alpha}_t}\beta_t", "bbox": [170, 235, 840, 300]},
    # VAE
    ("1312.6114", "1"): {"latex": r"\log p_\theta(\mathbf{x}^{(i)})=D_{\mathrm{KL}}(q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})\Vert p_\theta(\mathbf{z}\mid\mathbf{x}^{(i)}))+\mathcal{L}(\theta,\phi;\mathbf{x}^{(i)})"},
    ("1312.6114", "2"): {"latex": r"\log p_\theta(\mathbf{x}^{(i)})\geq\mathcal{L}(\theta,\phi;\mathbf{x}^{(i)})=\mathbb{E}_{q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})}[-\log q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})+\log p_\theta(\mathbf{x}^{(i)},\mathbf{z})]"},
    ("1312.6114", "3"): {"latex": r"\mathcal{L}(\theta,\phi;\mathbf{x}^{(i)})=-D_{\mathrm{KL}}(q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})\Vert p_\theta(\mathbf{z}))+\mathbb{E}_{q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})}[\log p_\theta(\mathbf{x}^{(i)}\mid\mathbf{z})]"},
    ("1312.6114", "4"): {"latex": r"\tilde{\mathbf{z}}=g_\phi(\boldsymbol{\epsilon},\mathbf{x}),\quad\boldsymbol{\epsilon}\sim p(\boldsymbol{\epsilon})"},
    ("1312.6114", "5"): {"latex": r"\mathbb{E}_{q_\phi(\mathbf{z}\mid\mathbf{x}^{(i)})}[f(\mathbf{z})]=\mathbb{E}_{p(\boldsymbol{\epsilon})}[f(g_\phi(\boldsymbol{\epsilon},\mathbf{x}^{(i)}))]\simeq\frac{1}{L}\sum_{l=1}^{L}f(g_\phi(\boldsymbol{\epsilon}^{(l)},\mathbf{x}^{(i)})),\quad\boldsymbol{\epsilon}^{(l)}\sim p(\boldsymbol{\epsilon})"},
    ("1312.6114", "6"): {"latex": r"\widetilde{\mathcal{L}}^{A}(\theta,\phi;\mathbf{x}^{(i)})=\frac{1}{L}\sum_{l=1}^{L}\left(\log p_\theta(\mathbf{x}^{(i)},\mathbf{z}^{(i,l)})-\log q_\phi(\mathbf{z}^{(i,l)}\mid\mathbf{x}^{(i)})\right)", "bbox": [180, 835, 840, 925]},
    # LayerNorm：原自动定位把 Eq. (3) 的正文引用当成锚点。
    ("1607.06450", "1"): {"page": 2, "bbox": [160, 305, 840, 375], "latex": r"a_i^l=(w_i^l)^\top h^l,\qquad h_i^{l+1}=f(a_i^l+b_i^l)"},
    ("1607.06450", "2"): {"page": 2, "bbox": [160, 485, 840, 565], "latex": r"\bar{a}_i^l=\frac{g_i^l}{\sigma_i^l}(a_i^l-\mu_i^l),\qquad\mu_i^l=\mathbb{E}_{\mathbf{x}\sim P(\mathbf{x})}[a_i^l],\qquad\sigma_i^l=\sqrt{\mathbb{E}_{\mathbf{x}\sim P(\mathbf{x})}[(a_i^l-\mu_i^l)^2]}"},
    ("1607.06450", "3"): {"page": 2, "bbox": [330, 785, 840, 850], "latex": r"\mu^l=\frac{1}{H}\sum_{i=1}^{H}a_i^l,\qquad\sigma^l=\sqrt{\frac{1}{H}\sum_{i=1}^{H}(a_i^l-\mu^l)^2}"},
    ("1607.06450", "4"): {"page": 3, "bbox": [160, 300, 840, 390], "latex": r"\mathbf{h}^t=f\left[\frac{\mathbf{g}}{\sigma^t}\odot(\mathbf{a}^t-\mu^t)+\mathbf{b}\right],\quad\mu^t=\frac{1}{H}\sum_{i=1}^{H}a_i^t,\quad\sigma^t=\sqrt{\frac{1}{H}\sum_{i=1}^{H}(a_i^t-\mu^t)^2}"},
    ("1607.06450", "5"): {"page": 3, "bbox": [250, 815, 840, 890], "latex": r"h_i=f\left(\frac{g_i}{\sigma_i}(a_i-\mu_i)+b_i\right)"},
    ("1607.06450", "6"): {"page": 4, "bbox": [160, 320, 840, 450], "latex": r"\mathbf{h}'=f\left[\frac{\mathbf{g}}{\sigma'}(W'\mathbf{x}-\mu')+\mathbf{b}\right]=f\left[\frac{\mathbf{g}}{\sigma'}((\delta W+\mathbf{1}\gamma^\top)\mathbf{x}-\mu')+\mathbf{b}\right]=f\left[\frac{\mathbf{g}}{\sigma}(W\mathbf{x}-\mu)+\mathbf{b}\right]=\mathbf{h}"},
    # LoRA
    ("2106.09685", "1"): {"latex": r"\max_{\Phi}\sum_{(x,y)\in\mathcal{Z}}\sum_{t=1}^{|y|}\log P_{\Phi}(y_t\mid x,y_{<t})"},
    ("2106.09685", "2"): {"latex": r"\max_{\Theta}\sum_{(x,y)\in\mathcal{Z}}\sum_{t=1}^{|y|}\log p_{\Phi_0+\Delta\Phi(\Theta)}(y_t\mid x,y_{<t})"},
    # DQN
    ("1312.5602", "1"): {"bbox": [230, 105, 850, 175], "latex": r"Q^*(s,a)=\mathbb{E}_{s'\sim\mathcal{E}}[r+\gamma\max_{a'}Q^*(s',a')\mid s,a]"},
    ("1312.5602", "2"): {"bbox": [230, 305, 850, 370], "latex": r"L_i(\theta_i)=\mathbb{E}_{s,a\sim\rho(\cdot)}[(y_i-Q(s,a;\theta_i))^2]"},
    ("1312.5602", "3"): {"bbox": [180, 425, 850, 500], "latex": r"\nabla_{\theta_i}L_i(\theta_i)=\mathbb{E}_{s,a\sim\rho(\cdot),s'\sim\mathcal{E}}[(r+\gamma\max_{a'}Q(s',a';\theta_{i-1})-Q(s,a;\theta_i))\nabla_{\theta_i}Q(s,a;\theta_i)]"},
    # GAN 多行公式不能按编号所在单行裁剪。
    ("1406.2661", "1"): {"bbox": [190, 120, 850, 180]},
    ("1406.2661", "2"): {"bbox": [330, 495, 850, 570]},
    ("1406.2661", "3"): {"bbox": [190, 585, 850, 705], "latex": r"V(G,D)=\int_{\mathbf{x}}p_{\mathrm{data}}(\mathbf{x})\log D(\mathbf{x})+p_g(\mathbf{x})\log(1-D(\mathbf{x}))\,d\mathbf{x}"},
    ("1406.2661", "4"): {"bbox": [190, 765, 850, 955], "latex": r"C(G)=\max_D V(G,D)=\mathbb{E}_{\mathbf{x}\sim p_{\mathrm{data}}}[\log D_G^*(\mathbf{x})]+\mathbb{E}_{\mathbf{z}\sim p_{\mathbf{z}}}[\log(1-D_G^*(G(\mathbf{z})))]=\mathbb{E}_{\mathbf{x}\sim p_{\mathrm{data}}}[\log D_G^*(\mathbf{x})]+\mathbb{E}_{\mathbf{x}\sim p_g}[\log(1-D_G^*(\mathbf{x}))]"},
    ("1406.2661", "5"): {"bbox": [190, 215, 850, 295]},
    # PPO
    ("1707.06347", "1"): {"bbox": [260, 215, 850, 275], "latex": r"\hat{g}=\hat{\mathbb{E}}_t[\nabla_\theta\log\pi_\theta(a_t\mid s_t)\hat{A}_t]"},
    ("1707.06347", "2"): {"bbox": [260, 340, 850, 410], "latex": r"L^{PG}(\theta)=\hat{\mathbb{E}}_t[\log\pi_\theta(a_t\mid s_t)\hat{A}_t]"},
    ("1707.06347", "3"): {"bbox": [250, 520, 850, 575], "latex": r"\underset{\theta}{\operatorname{maximize}}\ \hat{\mathbb{E}}_t\left[\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}\hat{A}_t\right]"},
    ("1707.06347", "4"): {"bbox": [250, 580, 850, 625], "latex": r"\operatorname{subject\ to}\ \hat{\mathbb{E}}_t[\mathrm{KL}[\pi_{\theta_{\mathrm{old}}}(\cdot\mid s_t),\pi_\theta(\cdot\mid s_t)]]\leq\delta"},
    ("1707.06347", "5"): {"bbox": [230, 675, 850, 745], "latex": r"\underset{\theta}{\operatorname{maximize}}\ \hat{\mathbb{E}}_t\left[\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}\hat{A}_t-\beta\,\mathrm{KL}[\pi_{\theta_{\mathrm{old}}}(\cdot\mid s_t),\pi_\theta(\cdot\mid s_t)]\right]"},
    ("1707.06347", "6"): {"bbox": [230, 180, 850, 250], "latex": r"L^{CPI}(\theta)=\hat{\mathbb{E}}_t\left[\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}\hat{A}_t\right]=\hat{\mathbb{E}}_t[r_t(\theta)\hat{A}_t]"},
    ("1707.06347", "7"): {"bbox": [220, 315, 850, 385], "latex": r"L^{CLIP}(\theta)=\hat{\mathbb{E}}_t[\min(r_t(\theta)\hat{A}_t,\operatorname{clip}(r_t(\theta),1-\epsilon,1+\epsilon)\hat{A}_t)]"},
    # Neural ODE：统一展开作者宏，并按页面人工修正长公式框。
    ("1806.07366", "1"): {"bbox": [220, 555, 540, 615], "latex": r"\mathbf{h}_{t+1}=\mathbf{h}_t+f(\mathbf{h}_t,\theta_t)"},
    ("1806.07366", "2"): {"bbox": [210, 700, 540, 775], "latex": r"\frac{d\mathbf{h}(t)}{dt}=f(\mathbf{h}(t),t,\theta)"},
    ("1806.07366", "3"): {"bbox": [190, 485, 850, 560], "latex": r"L(\mathbf{z}(t_1))=L\left(\mathbf{z}(t_0)+\int_{t_0}^{t_1}f(\mathbf{z}(t),t,\theta)\,dt\right)=L(\operatorname{ODESolve}(\mathbf{z}(t_0),f,t_0,t_1,\theta))"},
    ("1806.07366", "4"): {"bbox": [500, 600, 850, 700], "latex": r"\frac{d\mathbf{a}(t)}{dt}=-\mathbf{a}(t)^\top\frac{\partial f(\mathbf{z}(t),t,\theta)}{\partial\mathbf{z}}"},
    ("1806.07366", "5"): {"bbox": [490, 795, 850, 885], "latex": r"\frac{dL}{d\theta}=-\int_{t_1}^{t_0}\mathbf{a}(t)^\top\frac{\partial f(\mathbf{z}(t),t,\theta)}{\partial\theta}\,dt"},
    ("1806.07366", "6"): {"bbox": [230, 465, 850, 555], "latex": r"\mathbf{z}_1=f(\mathbf{z}_0)\Longrightarrow\log p(\mathbf{z}_1)=\log p(\mathbf{z}_0)-\log\left|\det\frac{\partial f}{\partial\mathbf{z}_0}\right|"},
    ("1806.07366", "7"): {"bbox": [190, 525, 850, 615], "latex": r"\mathbf{z}(t+1)=\mathbf{z}(t)+u h(w^\top\mathbf{z}(t)+b),\quad\log p(\mathbf{z}(t+1))=\log p(\mathbf{z}(t))-\log\left|1+u^\top\frac{\partial h}{\partial\mathbf{z}}\right|"},
    ("1806.07366", "8"): {"bbox": [270, 710, 850, 805], "latex": r"\frac{\partial\log p(\mathbf{z}(t))}{\partial t}=-\operatorname{tr}\left(\frac{df}{d\mathbf{z}(t)}\right)"},
    ("1806.07366", "9"): {"bbox": [260, 820, 850, 920], "latex": r"\frac{d\mathbf{z}(t)}{dt}=u h(w^\top\mathbf{z}(t)+b),\quad\frac{\partial\log p(\mathbf{z}(t))}{\partial t}=-u^\top\frac{\partial h}{\partial\mathbf{z}(t)}"},
    ("1806.07366", "10"): {"bbox": [260, 150, 850, 240], "latex": r"\frac{d\mathbf{z}(t)}{dt}=\sum_{n=1}^{M}f_n(\mathbf{z}(t)),\quad\frac{d\log p(\mathbf{z}(t))}{dt}=\sum_{n=1}^{M}\operatorname{tr}\left(\frac{\partial f_n}{\partial\mathbf{z}}\right)"},
    ("1806.07366", "11"): {"bbox": [260, 585, 850, 640], "latex": r"\mathbf{z}_{t_0}\sim p(\mathbf{z}_{t_0})"},
    ("1806.07366", "12"): {"bbox": [250, 610, 850, 670], "latex": r"\mathbf{z}_{t_1},\mathbf{z}_{t_2},\ldots,\mathbf{z}_{t_N}=\operatorname{ODESolve}(\mathbf{z}_{t_0},f,\theta_f,t_0,\ldots,t_N)"},
}

MANUAL_FORMULAS = {
    "1502.03167": [
        {"number": "BN-1", "page": 1, "bbox": [190, 755, 500, 815], "latex": r"\Theta=\arg\min_{\Theta}\frac{1}{N}\sum_{i=1}^{N}\ell(x_i,\Theta)"},
        {"number": "BN-2", "page": 1, "bbox": [590, 595, 850, 645], "latex": r"\ell=F_2(F_1(u,\Theta_1),\Theta_2)"},
        {"number": "BN-3", "page": 3, "bbox": [100, 705, 430, 775], "latex": r"\widehat{x}^{(k)}=\frac{x^{(k)}-\mathbb{E}[x^{(k)}]}{\sqrt{\operatorname{Var}[x^{(k)}]}}"},
        {"number": "BN-4", "page": 3, "bbox": [500, 610, 900, 855], "latex": r"\begin{aligned}\mu_{\mathcal{B}}&=\frac{1}{m}\sum_{i=1}^{m}x_i\\\sigma_{\mathcal{B}}^2&=\frac{1}{m}\sum_{i=1}^{m}(x_i-\mu_{\mathcal{B}})^2\\\widehat{x}_i&=\frac{x_i-\mu_{\mathcal{B}}}{\sqrt{\sigma_{\mathcal{B}}^2+\epsilon}}\\y_i&=\gamma\widehat{x}_i+\beta\end{aligned}"},
        {"number": "BN-5", "page": 4, "bbox": [100, 450, 505, 660], "latex": r"\begin{aligned}\frac{\partial\ell}{\partial\widehat{x}_i}&=\frac{\partial\ell}{\partial y_i}\gamma\\\frac{\partial\ell}{\partial\sigma_{\mathcal{B}}^2}&=\sum_{i=1}^{m}\frac{\partial\ell}{\partial\widehat{x}_i}(x_i-\mu_{\mathcal{B}})\left(-\frac{1}{2}\right)(\sigma_{\mathcal{B}}^2+\epsilon)^{-3/2}\\\frac{\partial\ell}{\partial\mu_{\mathcal{B}}}&=\sum_{i=1}^{m}\frac{\partial\ell}{\partial\widehat{x}_i}\frac{-1}{\sqrt{\sigma_{\mathcal{B}}^2+\epsilon}}+\frac{\partial\ell}{\partial\sigma_{\mathcal{B}}^2}\frac{\sum_{i=1}^{m}-2(x_i-\mu_{\mathcal{B}})}{m}\\\frac{\partial\ell}{\partial x_i}&=\frac{\partial\ell}{\partial\widehat{x}_i}\frac{1}{\sqrt{\sigma_{\mathcal{B}}^2+\epsilon}}+\frac{\partial\ell}{\partial\sigma_{\mathcal{B}}^2}\frac{2(x_i-\mu_{\mathcal{B}})}{m}+\frac{\partial\ell}{\partial\mu_{\mathcal{B}}}\frac{1}{m}\end{aligned}"},
    ]
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", default="local-artifacts/pdf-ocr-poc")
    parser.add_argument("--output", default="tests/fixtures/pdf-ocr-gold.generated.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    artifacts = (root / args.artifacts).resolve()
    corpus = json.loads((root / "tests/fixtures/pdf-ocr-corpus.json").read_text(encoding="utf-8"))
    formulas: list[dict] = []
    crop_root = artifacts / "gold-crops"
    crop_root.mkdir(parents=True, exist_ok=True)

    for paper in corpus["papers"]:
        paper_id = paper["id"]
        quota = QUOTAS[paper_id]
        manual = MANUAL_FORMULAS.get(paper_id, [])
        if quota == 0 and not manual:
            continue
        pdf_path = artifacts / "pdfs" / f"{paper_id}.pdf"
        document = pdfium.PdfDocument(pdf_path)
        selected = []
        if quota:
            reference_path = artifacts / "references" / f"{paper_id}.json"
            reference = json.loads(reference_path.read_text(encoding="utf-8"))
            source_by_number = load_source_equations(
                artifacts / "source-archives" / f"{paper_id}.bin"
            )
            reference_by_number = {
                item["number"]: item for item in reference.get("equations", [])
            }
            expected = []
            for number in range(1, quota + 1):
                item = reference_by_number.get(str(number)) or source_by_number.get(str(number)) or {
                    "number": str(number),
                    "latex": "__TRANSCRIBE__",
                    "htmlId": None,
                }
                expected.append(item)
            selected = locate_equations(document, expected, quota, paper_id in TWO_COLUMN)
            if len(selected) < quota:
                raise RuntimeError(f"{paper_id} 只定位到 {len(selected)}/{quota} 条编号公式")
        selected.extend(manual)
        paper_crops = crop_root / paper_id
        paper_crops.mkdir(parents=True, exist_ok=True)
        for stale_crop in paper_crops.glob("*.png"):
            stale_crop.unlink()
        for ordinal, item in enumerate(selected, start=1):
            override = OVERRIDES.get((paper_id, item["number"]), {})
            item = {**item, **override}
            formula_id = f"{paper_id}-p{item['page']:02d}-e{slug(item['number'])}"
            formula = {
                "id": formula_id,
                "paperId": paper_id,
                "page": item["page"],
                "bbox": item["bbox"],
                "latex": item["latex"],
                "display": True,
                "category": category(item["latex"]),
                "equationNumber": item["number"],
                "core": (paper_id, item["number"]) in CORE,
                "reference": "author-reference-manual-reviewed",
            }
            formulas.append(formula)
            render_crop(document, formula, paper_crops / f"{ordinal:02d}-{formula_id}.png")
        make_contact_sheet(paper_crops, crop_root / f"{paper_id}-contact.png")

    payload = {
        "schemaVersion": 1,
        "coordinateSystem": "top-left-0-1000",
        "evaluationMode": corpus["evaluationMode"],
        "annotation": {
            "status": "manual-reviewed",
            "referenceUse": "作者 HTML 仅用于金标，不进入 OCR 引擎输入",
        },
        "formulas": formulas,
    }
    output = (root / args.output).resolve()
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"generated {len(formulas)} formulas: {output}")
    print(f"contact sheets: {crop_root}")


def locate_equations(
    document: pdfium.PdfDocument,
    equations: list[dict],
    quota: int,
    two_column: bool,
) -> list[dict]:
    page_text: list[tuple[object, tuple[float, float]]] = []
    for page_index in range(len(document)):
        page = document[page_index]
        text_page = page.get_textpage()
        page_text.append((text_page, page.get_size()))

    located: list[dict] = []
    used_positions: set[tuple[int, int]] = set()
    for equation in equations:
        needle = f"({equation['number']})"
        candidates = []
        for page_index, (text_page, size) in enumerate(page_text):
            searcher = text_page.search(needle)
            while True:
                match = searcher.get_next()
                if match is None:
                    break
                index, count = match
                anchor = char_range_box(text_page, index, index + count)
                if anchor is None:
                    continue
                context_start = max(0, index - 120)
                context = text_page.get_text_range(
                    context_start,
                    min(260, text_page.count_chars() - context_start),
                )
                math_factor = 3.0 if re.search(r"[=≤≥←→∝]", context) else 1.0
                score = anchor_score(anchor, size, two_column) * math_factor
                bbox = formula_row_box(text_page, anchor, size, two_column)
                width, height = size
                anchor_center = [
                    round(((anchor[0] + anchor[2]) / 2) / width * 1000),
                    round((height - (anchor[1] + anchor[3]) / 2) / height * 1000),
                ]
                candidates.append((score, page_index, index, bbox, anchor_center))
        candidates.sort(reverse=True)
        chosen = next((item for item in candidates if (item[1], item[2]) not in used_positions), None)
        if chosen is None or chosen[0] < 0.25:
            continue
        _, page_index, index, bbox, anchor_center = chosen
        used_positions.add((page_index, index))
        located.append({
            **equation,
            "page": page_index + 1,
            "bbox": bbox,
            "_anchor": anchor_center,
        })
        if len(located) >= quota:
            break
    separate_vertical_overlaps(located)
    for item in located:
        item.pop("_anchor", None)
    return located


def separate_vertical_overlaps(located: list[dict]) -> None:
    groups: dict[tuple[int, int], list[dict]] = {}
    for item in located:
        column = 0 if item["_anchor"][0] < 600 else 1
        groups.setdefault((item["page"], column), []).append(item)
    for items in groups.values():
        items.sort(key=lambda item: item["_anchor"][1])
        for index, item in enumerate(items):
            y0, y1 = item["bbox"][1], item["bbox"][3]
            if index > 0:
                previous = items[index - 1]
                boundary = (previous["_anchor"][1] + item["_anchor"][1]) // 2
                y0 = max(y0, boundary - 10)
            if index + 1 < len(items):
                following = items[index + 1]
                boundary = (item["_anchor"][1] + following["_anchor"][1]) // 2
                y1 = min(y1, boundary + 10)
            if y1 > y0:
                item["bbox"][1] = y0
                item["bbox"][3] = y1


def load_source_equations(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    raw = bounded_gzip(path.read_bytes(), 64 * 1024 * 1024)
    files: dict[str, str] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive.getmembers():
                normalized = posixpath.normpath(member.name.replace("\\", "/"))
                if (
                    not member.isfile()
                    or member.issym()
                    or member.islnk()
                    or normalized.startswith("../")
                    or normalized.startswith("/")
                    or not normalized.lower().endswith(".tex")
                    or member.size > 8 * 1024 * 1024
                ):
                    continue
                stream = archive.extractfile(member)
                if stream is not None:
                    files[normalized] = stream.read().decode("utf-8", "replace")
    except tarfile.TarError:
        files["main.tex"] = raw.decode("utf-8", "replace")
    mains = [
        name for name, source in files.items()
        if "\\documentclass" in source and "\\begin{document}" in source
    ]
    if not mains:
        return {}
    main_name = max(mains, key=lambda name: len(files[name]))
    expanded = expand_inputs(main_name, files, set(), 0)
    return extract_source_equations(expanded)


def bounded_gzip(data: bytes, limit: int) -> bytes:
    if not data.startswith(b"\x1f\x8b"):
        if len(data) > limit:
            raise RuntimeError("源码参考超过解压上限")
        return data
    output = bytearray()
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        while True:
            chunk = stream.read(min(1024 * 1024, limit + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > limit:
                raise RuntimeError("源码参考超过 64 MiB 解压上限")
    return bytes(output)


def expand_inputs(name: str, files: dict[str, str], stack: set[str], depth: int) -> str:
    if depth > 32 or name in stack:
        return ""
    source = files.get(name, "")
    stack = {*stack, name}
    base = posixpath.dirname(name)
    pattern = re.compile(r"\\(?:input|include)\s*(?:\{([^}]+)\}|([^\s%]+))")

    def replace(match: re.Match) -> str:
        target = (match.group(1) or match.group(2)).strip()
        if not target.lower().endswith(".tex"):
            target += ".tex"
        resolved = posixpath.normpath(posixpath.join(base, target))
        if resolved.startswith("../") or resolved.startswith("/"):
            return ""
        return expand_inputs(resolved, files, stack, depth + 1)

    return pattern.sub(replace, source)


def extract_source_equations(source: str) -> dict[str, dict]:
    source = strip_tex_comments(source)
    pattern = re.compile(
        r"\\begin\{(equation\*?|align\*?|flalign\*?|gather\*?|multline\*?|eqnarray\*?)\}"
        r"([\s\S]*?)\\end\{\1\}"
    )
    counter = 0
    equations: dict[str, dict] = {}
    for match in pattern.finditer(source):
        env, body = match.group(1), match.group(2).strip()
        starred = env.endswith("*")
        base_env = env.rstrip("*")
        if starred and "\\eqnr" not in body and "\\tag{" not in body:
            continue
        rows = [body]
        if base_env in {"align", "flalign", "gather", "eqnarray"}:
            rows = [row.strip() for row in body.split("\\\\") if row.strip()]
        for row in rows:
            if "\\nonumber" in row or "\\notag" in row:
                continue
            explicit = re.search(r"\\tag\s*\{([^}]+)\}", row)
            if explicit:
                number = explicit.group(1).strip()
                if number.isdigit():
                    counter = max(counter, int(number))
            else:
                counter += 1
                number = str(counter)
            latex = re.sub(r"\\(?:label|tag)\s*\{[^}]*\}", "", row)
            latex = latex.replace("\\eqnr", "")
            latex = re.sub(r"\s+", " ", latex).strip().strip("&").strip()
            if not latex:
                continue
            equations.setdefault(number, {
                "number": number,
                "latex": latex,
                "htmlId": None,
            })
    return equations


def strip_tex_comments(source: str) -> str:
    output = []
    for line in source.splitlines():
        match = re.search(r"(?<!\\)%", line)
        output.append(line[:match.start()] if match else line)
    return "\n".join(output)


def char_range_box(text_page, start: int, end: int):
    boxes = []
    for index in range(start, end):
        try:
            box = text_page.get_charbox(index)
        except Exception:
            continue
        if box[2] > box[0] and box[3] > box[1]:
            boxes.append(box)
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def anchor_score(anchor, size, two_column: bool) -> float:
    width, height = size
    x = ((anchor[0] + anchor[2]) / 2) / width
    y = ((anchor[1] + anchor[3]) / 2) / height
    targets = (0.46, 0.82, 0.94) if two_column else (0.82, 0.9)
    margin_score = max(math.exp(-abs(x - target) * 16) for target in targets)
    body_score = 1.0 if 0.08 < y < 0.92 else 0.1
    return margin_score * body_score


def formula_row_box(text_page, anchor, size, two_column: bool) -> list[int]:
    width, height = size
    anchor_y = (anchor[1] + anchor[3]) / 2
    boxes = []
    for index in range(text_page.count_chars()):
        try:
            box = text_page.get_charbox(index)
        except Exception:
            continue
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        center_y = (box[1] + box[3]) / 2
        same_band = abs(center_y - anchor_y) <= 18
        same_column = not two_column or (
            (anchor[0] < width * 0.58 and box[2] < width * 0.58)
            or (anchor[0] >= width * 0.58 and box[0] >= width * 0.42)
        )
        if same_band and same_column and box[0] <= anchor[2] + 4:
            boxes.append(box)
    if boxes:
        x0 = max(0, min(box[0] for box in boxes) - 10)
        x1 = min(width, max(anchor[2], max(box[2] for box in boxes)) + 10)
        y0 = max(0, min(box[1] for box in boxes) - 8)
        y1 = min(height, max(box[3] for box in boxes) + 8)
    else:
        x0, x1 = (width * 0.08, anchor[2] + 12)
        y0, y1 = (max(0, anchor_y - 36), min(height, anchor_y + 36))
    return [
        round(x0 / width * 1000),
        round((height - y1) / height * 1000),
        round(x1 / width * 1000),
        round((height - y0) / height * 1000),
    ]


def render_crop(document: pdfium.PdfDocument, formula: dict, output: Path) -> None:
    page = document[formula["page"] - 1]
    image = page.render(scale=2).to_pil()
    x0, y0, x1, y1 = formula["bbox"]
    crop = image.crop((
        max(0, x0 * image.width // 1000),
        max(0, y0 * image.height // 1000),
        min(image.width, math.ceil(x1 * image.width / 1000)),
        min(image.height, math.ceil(y1 * image.height / 1000)),
    ))
    canvas = Image.new("RGB", (max(900, crop.width), crop.height + 60), "white")
    canvas.paste(crop, (0, 60))
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 8), f"{formula['id']}  eq.({formula['equationNumber']})", fill="black")
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def make_contact_sheet(source: Path, output: Path) -> None:
    images = [Image.open(path).convert("RGB") for path in sorted(source.glob("*.png"))]
    if not images:
        return
    width = max(image.width for image in images)
    height = sum(image.height for image in images) + 12 * (len(images) - 1)
    sheet = Image.new("RGB", (width, height), "#dddddd")
    y = 0
    for image in images:
        sheet.paste(image, (0, y))
        y += image.height + 12
    sheet.save(output)


def category(latex: str) -> str:
    if re.search(r"\\begin\{(?:matrix|pmatrix|bmatrix|cases|aligned|align)", latex):
        return "matrix-or-multiline"
    if "\\frac" in latex:
        return "fraction"
    if "\\sqrt" in latex:
        return "root"
    if re.search(r"\\(?:sum|prod|int)", latex):
        return "large-operator"
    if re.search(r"(?:log|p_|q_|\\mathcal\{L\}|\\mathbb\{E\})", latex):
        return "probability-or-loss"
    return "other"


def slug(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z]+", "-", value).strip("-").lower()


if __name__ == "__main__":
    main()
