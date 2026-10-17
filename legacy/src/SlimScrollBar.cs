using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>
    /// 极简粉色圆角滚动条，替换 ListBox 自带的系统灰滚动条。
    /// 本身不接收交互（列表仍可用滚轮/方向键），仅作视觉指示。
    /// </summary>
    internal sealed class SlimScrollBar : Control
    {
        private int _value;
        private int _maximum = 1;
        private int _largeChange = 1;
        private bool _hover;

        public SlimScrollBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Width = 5;
            Cursor = Cursors.Arrow;
        }

        /// <summary>滚动的最大值（通常是 item 总数 - 可见数）。</summary>
        public int Maximum
        {
            get { return _maximum; }
            set { _maximum = Math.Max(1, value); Invalidate(); }
        }

        public int LargeChange
        {
            get { return _largeChange; }
            set { _largeChange = Math.Max(1, value); Invalidate(); }
        }

        public int Value
        {
            get { return _value; }
            set
            {
                int v = Math.Max(0, Math.Min(value, _maximum));
                if (v == _value) return;
                _value = v;
                Invalidate();
            }
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.EnableSmoothing(g);

            // 轨道：极淡玫瑰色，几乎不可见
            using (var path = Theme.RoundRect(new Rectangle(0, 0, Width - 1, Height - 1), Width / 2))
            using (var b = new SolidBrush(Color.FromArgb(18, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B)))
                g.FillPath(b, path);

            // 滑块尺寸按 可见/总数 比例
            int total = _maximum + _largeChange;
            float ratio = total <= 0 ? 1f : (float)_largeChange / total;
            int thumbH = Math.Max(22, (int)(Height * ratio));
            int range = Height - thumbH;
            float pos = _maximum <= 0 ? 0 : (float)_value / _maximum;
            int thumbY = (int)(range * Math.Max(0f, Math.Min(1f, pos)));

            var thumb = new Rectangle(0, thumbY, Width - 1, thumbH);
            using (var path = Theme.RoundRect(thumb, Width / 2))
            {
                Color c = _hover
                    ? Theme.Accent                                    // 悬停 = 实主色
                    : Color.FromArgb(200, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B); // 平时 = 80% 主色
                using (var b = new SolidBrush(c))
                    g.FillPath(b, path);
            }
        }
    }
}
