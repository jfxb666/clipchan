using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace Clipchan
{
    /// <summary>列表左侧的类型徽标：圆角底色 + 简约图形，风格与主题统一。</summary>
    internal static class KindIcon
    {
        /// <summary>返回该类型对应的主题色。</summary>
        public static Color AccentOf(ClipKind k)
        {
            // 全部从新主题的基础色系派生：先 Blend 50% 白得到浅色底，
            // Blend 15% 黑得到同系深色用于图标笔触，保证五大类型色彩语系统一。
            switch (k)
            {
                case ClipKind.Link:   return Color.FromArgb(255,  92, 158, 242);  // 天蓝
                case ClipKind.Code:   return Color.FromArgb(255, 150, 124, 244);  // 星紫
                case ClipKind.Path:   return Color.FromArgb(255, 240, 168,  68);  // 蜜柑
                case ClipKind.Number: return Color.FromArgb(255,  60, 189, 146);  // 薄荷
                default:              return Theme.Accent;                       // 赛博粉
            }
        }

        /// <summary>在指定矩形内绘制类型徽标。</summary>
        public static void Draw(Graphics g, ClipKind kind, Rectangle box, bool onSelected)
        {
            Theme.EnableSmoothing(g);
            Color accent = AccentOf(kind);

            // 徽标底：主题感知的强调色淡底（暗色下提高不透明度才看得见）；选中态用主色底
            using (var path = Theme.RoundRect(box, Theme.RadiusBadge))
            {
                Color fill = onSelected
                    ? Theme.Accent
                    : Color.FromArgb(Theme.BadgeTintAlpha, accent.R, accent.G, accent.B);
                using (var b = new SolidBrush(fill)) g.FillPath(b, path);
            }

            Color ink = onSelected ? Theme.InkInvert : accent;
            float cx = box.X + box.Width / 2f;
            float cy = box.Y + box.Height / 2f;
            float s = box.Width * 0.30f;   // 图形基准尺寸

            using (var pen = new Pen(ink, Math.Max(1.3f, box.Width * 0.075f)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;

                switch (kind)
                {
                    case ClipKind.Link:   DrawLink(g, pen, cx, cy, s); break;
                    case ClipKind.Code:   DrawCode(g, pen, cx, cy, s); break;
                    case ClipKind.Path:   DrawFolder(g, pen, cx, cy, s); break;
                    case ClipKind.Number: DrawHash(g, pen, cx, cy, s); break;
                    default:              DrawText(g, pen, cx, cy, s); break;
                }
            }
        }

        // 链接：两个相连的环，中间用短杆连接
        private static void DrawLink(Graphics g, Pen p, float cx, float cy, float s)
        {
            float w = s * 1.05f;
            float h = s * 0.85f;
            float gap = s * 0.30f;

            g.DrawArc(p, cx - gap - w, cy - h / 2, w, h, 45f, 270f);
            g.DrawArc(p, cx + gap, cy - h / 2, w, h, 225f, 270f);
            g.DrawLine(p, cx - gap * 0.55f, cy, cx + gap * 0.55f, cy);
        }

        // 代码：左右尖括号 + 中间斜杠
        private static void DrawCode(Graphics g, Pen p, float cx, float cy, float s)
        {
            g.DrawLines(p, new[] {
                new PointF(cx - s * 0.25f, cy - s * 0.85f),
                new PointF(cx - s * 1.05f, cy),
                new PointF(cx - s * 0.25f, cy + s * 0.85f) });
            g.DrawLines(p, new[] {
                new PointF(cx + s * 0.25f, cy - s * 0.85f),
                new PointF(cx + s * 1.05f, cy),
                new PointF(cx + s * 0.25f, cy + s * 0.85f) });
        }

        // 文件夹
        private static void DrawFolder(Graphics g, Pen p, float cx, float cy, float s)
        {
            var body = new RectangleF(cx - s * 1.15f, cy - s * 0.55f, s * 2.3f, s * 1.5f);
            using (var path = Theme.RoundRect(Rectangle.Round(body), (int)(s * 0.5f)))
                g.DrawPath(p, path);
            g.DrawLine(p, cx - s * 1.05f, cy - s * 0.75f, cx - s * 0.25f, cy - s * 0.75f);
        }

        // 井号（数字）
        private static void DrawHash(Graphics g, Pen p, float cx, float cy, float s)
        {
            g.DrawLine(p, cx - s * 0.45f, cy - s * 1.0f, cx - s * 0.75f, cy + s * 1.0f);
            g.DrawLine(p, cx + s * 0.55f, cy - s * 1.0f, cx + s * 0.25f, cy + s * 1.0f);
            g.DrawLine(p, cx - s * 1.1f, cy - s * 0.3f, cx + s * 1.1f, cy - s * 0.3f);
            g.DrawLine(p, cx - s * 1.1f, cy + s * 0.45f, cx + s * 1.1f, cy + s * 0.45f);
        }

        // 文本：三条横线
        private static void DrawText(Graphics g, Pen p, float cx, float cy, float s)
        {
            g.DrawLine(p, cx - s * 1.05f, cy - s * 0.6f, cx + s * 1.05f, cy - s * 0.6f);
            g.DrawLine(p, cx - s * 1.05f, cy, cx + s * 0.55f, cy);
            g.DrawLine(p, cx - s * 1.05f, cy + s * 0.6f, cx + s * 0.15f, cy + s * 0.6f);
        }
    }
}
