using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;

namespace Clipchan
{
    /// <summary>
    /// 图标与角色形象。优先加载内嵌 PNG 资源；
    /// 若资源缺失（例如未放入 assets/），退化为 GDI+ 程序化绘制，
    /// 保证任何情况下都有二次元观感而不是空白。
    /// </summary>
    internal static class Assets
    {
        private static Image _chan;

        /// <summary>主题切换时丢弃代码绘制的头像缓存（含主题色），下次访问按新配色重建。</summary>
        public static void Invalidate()
        {
            if (_chan != null) { _chan.Dispose(); _chan = null; }
        }

        /// <summary>Q 版猫娘头像；缺内嵌资源时代码绘制。</summary>
        public static Image Chan(int size)
        {
            Image embedded = TryEmbedded("chan.png");
            if (embedded != null) return Scale(embedded, size);

            if (_chan == null) _chan = DrawChan(size);
            return Scale(_chan, size);
        }

        private static Image TryEmbedded(string name)
        {
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                foreach (string n in asm.GetManifestResourceNames())
                {
                    if (!n.EndsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
                    using (var s = asm.GetManifestResourceStream(n))
                    {
                        if (s == null) continue;
                        // 复制到内存流，避免离开 using 后图像被释放
                        using (var ms = new System.IO.MemoryStream())
                        {
                            s.CopyTo(ms);
                            ms.Position = 0;
                            return Image.FromStream(ms);
                        }
                    }
                }
            }
            catch (Exception) { }
            return null;
        }

        private static Image Scale(Image src, int size)
        {
            if (src == null) return null;
            var bmp = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bmp))
            {
                Theme.EnableSmoothing(g);
                g.DrawImage(src, new Rectangle(0, 0, size, size));
            }
            return bmp;
        }

        /// <summary>程序化绘制 Q 版猫娘头像（圆脸 + 猫耳 + 眼睛 + 腮红）。</summary>
        private static Image DrawChan(int size)
        {
            var bmp = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bmp))
            {
                Theme.EnableSmoothing(g);
                float u = size / 32f; // 以 32x32 为设计基准等比缩放

                // 背景：粉紫渐变圆
                using (var bg = new LinearGradientBrush(
                    new Rectangle(0, 0, size, size), Theme.AccentSoft, Theme.Violet, 45f))
                using (var p = new GraphicsPath())
                {
                    p.AddEllipse(0, 0, size - 1, size - 1);
                    g.FillPath(bg, p);
                }

                // 猫耳（两个三角）
                using (var earBrush = new SolidBrush(Theme.AccentDark))
                {
                    g.FillPolygon(earBrush, new[]
                    {
                        new PointF(6f * u, 11f * u), new PointF(10f * u, 2f * u), new PointF(15f * u, 10f * u)
                    });
                    g.FillPolygon(earBrush, new[]
                    {
                        new PointF(17f * u, 10f * u), new PointF(22f * u, 2f * u), new PointF(26f * u, 11f * u)
                    });
                }

                // 脸
                using (var face = new SolidBrush(Color.FromArgb(255, 255, 235, 245)))
                    g.FillEllipse(face, 5f * u, 7f * u, 22f * u, 20f * u);

                // 眼睛：角色脸永远是浅粉色，瞳孔固定用深墨色（不随主题翻转，
                // 否则暗色主题下 Theme.Ink 变浅，会出现"白眼睛"）
                using (var eye = new SolidBrush(Color.FromArgb(255, 59, 43, 58)))
                {
                    g.FillEllipse(eye, 10.5f * u, 15f * u, 3.2f * u, 4.2f * u);
                    g.FillEllipse(eye, 18.3f * u, 15f * u, 3.2f * u, 4.2f * u);
                }
                using (var hi = new SolidBrush(Color.White))
                {
                    g.FillEllipse(hi, 11.3f * u, 15.8f * u, 1.3f * u, 1.3f * u);
                    g.FillEllipse(hi, 19.1f * u, 15.8f * u, 1.3f * u, 1.3f * u);
                }

                // 腮红
                using (var blush = new SolidBrush(Color.FromArgb(120, 255, 120, 165)))
                {
                    g.FillEllipse(blush, 8f * u, 20f * u, 3.4f * u, 2.0f * u);
                    g.FillEllipse(blush, 20.6f * u, 20f * u, 3.4f * u, 2.0f * u);
                }

                // 嘴（小 w 形弧）
                using (var pen = new Pen(Theme.Ink, 1.1f * u))
                {
                    pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                    g.DrawArc(pen, 13.4f * u, 20.6f * u, 2.6f * u, 2.2f * u, 20f, 140f);
                    g.DrawArc(pen, 16.0f * u, 20.6f * u, 2.6f * u, 2.2f * u, 20f, 140f);
                }

                // 外圈高光描边
                using (var pen = new Pen(Color.FromArgb(160, 255, 255, 255), Math.Max(1f, 1.2f * u)))
                    g.DrawEllipse(pen, 0.6f * u, 0.6f * u, size - 1.2f * u - 1, size - 1.2f * u - 1);
            }
            return bmp;
        }

        /// <summary>生成托盘图标（16/32 自适应）。</summary>
        public static Icon TrayIcon()
        {
            try
            {
                Image img = Chan(32);
                var bmp = new Bitmap(img, 32, 32);
                IntPtr h = bmp.GetHicon();
                using (var tmp = Icon.FromHandle(h))
                {
                    // 克隆一份，避免依赖已释放的句柄
                    return (Icon)tmp.Clone();
                }
            }
            catch (Exception)
            {
                return SystemIcons.Application;
            }
        }
    }
}
