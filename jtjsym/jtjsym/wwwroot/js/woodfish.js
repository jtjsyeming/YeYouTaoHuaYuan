// 夜游桃花源 电子木鱼「功德+1」飘字（C-48）
// 设计要点见《29-开发文档-电子木鱼功德飘字与按钮布局-v2.0.md》§2.2
//
// 为什么用 document 级事件委托、而不是 Blazor 的 @onclick → JS.InvokeVoidAsync：
//   Blazor Server 的 JS.InvokeVoidAsync 同样是"服务端 → 客户端"的一帧 SignalR 消息，
//   链路是「点击 →（上行）服务端 handler →（下行）JS 建节点」，弱网下飘字照样迟到。
//   这里把"监听点击"也放到客户端 —— JS 只负责视觉、Blazor 只负责计数，两条路互不等待：
//     点击 ─┬─（本地，0ms）  委托 → 命中 .muyu-btn → 建节点播动画
//           └─（上行一趟）   Blazor @onclick → knockCount++
//   附带好处：C# 侧不再需要 MouseEventArgs，高频连点（FISH-07 的 105 次）也不产生任何 interop。

const CLS = 'gongde-pop';
let bound = false;

function spawn(x, y) {
    const el = document.createElement('span');
    el.className = CLS;
    el.textContent = '功德+1';
    el.setAttribute('aria-hidden', 'true'); // 不打断 p[role=status] 的读屏播报
    // ±14px 抖动：连点时文字不叠成一列
    el.style.left = (x + (Math.random() * 28 - 14)) + 'px';
    el.style.top = y + 'px';
    el.addEventListener('animationend', () => el.remove(), { once: true });
    document.body.appendChild(el);
}

function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('.muyu-btn') : null;
    if (!btn) return;

    // 键盘激活（Enter/Space）触发的 click：detail === 0，clientX/Y 恒为 0，
    // 直接用会把飘字甩到视口左上角 —— 回退到按钮盒中心。
    if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) {
        const r = btn.getBoundingClientRect();
        spawn(r.left + r.width / 2, r.top + r.height / 2);
    } else {
        spawn(e.clientX, e.clientY);
    }
}

/** 幂等：重复调用只绑一次（切页回来组件重建不会一次点击出两个飘字）。捕获阶段绑，早于 Blazor 的冒泡处理。 */
export function register() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onClick, true);
}

export function unregister() {
    if (!bound) return;
    bound = false;
    document.removeEventListener('click', onClick, true);
}
