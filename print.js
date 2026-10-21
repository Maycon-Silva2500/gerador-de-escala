/* ==========================================================================
   FROTA.OS v5.0 - print.js
   Motor de Exportação (Impressão Nativa, PNG e PDF)
   ========================================================================== */

(function () {
  'use strict';

  const PrintManager = {
    init() {
      this.bindEvents();
    },

    bindEvents() {
      // Botão de Impressão Nativa
      const btnPrint = document.getElementById('btnPrint');
      if (btnPrint) {
        btnPrint.addEventListener('click', () => {
          this.printNative();
        });
      }

      // Botão de Exportação para PNG
      const btnExportPNG = document.getElementById('btnExportPNG');
      if (btnExportPNG) {
        btnExportPNG.addEventListener('click', () => {
          this.exportPNG();
        });
      }

      // Botão de Exportação para PDF
      const btnExportPDF = document.getElementById('btnExportPDF');
      if (btnExportPDF) {
        btnExportPDF.addEventListener('click', () => {
          this.exportPDF();
        });
      }
    },

    /**
     * Prepara a interface para garantir que a renderização da planilha
     * esteja com o layout correto antes da captura (100% de escala, sem recortes).
     */
    prepareForExport() {
      const container = document.querySelector('#livePreviewContainer .sheet-container');
      if (!container) return null;

      // Salva os estilos originais para restaurar depois
      const originalTransform = container.style.transform;
      const originalTransformOrigin = container.style.transformOrigin;

      // Reseta a escala para a captura manter a resolução e o tamanho nativo
      container.style.transform = 'scale(1)';
      container.style.transformOrigin = 'top left';

      return { container, originalTransform, originalTransformOrigin };
    },

    /**
     * Restaura a interface para o estado original após a captura
     */
    restoreAfterExport(setupData) {
      if (!setupData || !setupData.container) return;
      setupData.container.style.transform = setupData.originalTransform;
      setupData.container.style.transformOrigin = setupData.originalTransformOrigin;
    },

    /**
     * Chama a caixa de diálogo de impressão nativa do navegador.
     * O CSS do sistema (@media print) deve cuidar de ocultar menus e exibir apenas a grade.
     */
    printNative() {
      // Atualiza a prévia antes de imprimir para garantir dados frescos
      if (window.Renderer) {
        window.Renderer.renderLivePreview();
      }
      
      console.log('[PrintManager] Iniciando impressão nativa...');
      window.print();
    },

    /**
     * Exporta a visualização da escala para uma imagem PNG.
     * Requer a biblioteca html2canvas.
     */
    exportPNG() {
      if (typeof html2canvas === 'undefined') {
        alert('A biblioteca html2canvas não foi encontrada. Verifique os scripts no HTML.');
        return;
      }

      const setupData = this.prepareForExport();
      if (!setupData) {
        alert('Não foi possível encontrar a planilha para exportar.');
        return;
      }

      const filename = this.getExportFilename('png');
      const btn = document.getElementById('btnExportPNG');
      const originalText = btn ? btn.textContent : '';

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Gerando PNG...';
      }

      html2canvas(setupData.container, {
        scale: 2, // Aumenta a resolução da imagem final
        useCORS: true,
        backgroundColor: '#ffffff'
      }).then(canvas => {
        const link = document.createElement('a');
        link.download = filename;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }).catch(err => {
        console.error('Erro ao gerar PNG:', err);
        alert('Ocorreu um erro ao gerar a imagem.');
      }).finally(() => {
        this.restoreAfterExport(setupData);
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    },

    /**
     * Exporta a visualização da escala para um documento PDF.
     * Requer html2canvas e jspdf.
     */
    exportPDF() {
      if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
        alert('As bibliotecas html2canvas ou jsPDF não foram encontradas.');
        return;
      }

      const setupData = this.prepareForExport();
      if (!setupData) return;

      const filename = this.getExportFilename('pdf');
      const btn = document.getElementById('btnExportPDF');
      const originalText = btn ? btn.textContent : '';

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Gerando PDF...';
      }

      const { jsPDF } = window.jspdf;

      html2canvas(setupData.container, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff'
      }).then(canvas => {
        const imgData = canvas.toDataURL('image/png');
        
        // Calcula as proporções para caber no PDF (A4 Paisagem por padrão)
        const pdf = new jsPDF({
          orientation: 'landscape',
          unit: 'mm',
          format: 'a4'
        });

        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        
        const imgWidth = canvas.width;
        const imgHeight = canvas.height;
        
        const ratio = Math.min(pdfWidth / imgWidth, pdfHeight / imgHeight);
        
        const finalWidth = imgWidth * ratio;
        const finalHeight = imgHeight * ratio;
        
        // Centraliza verticalmente e horizontalmente (opcional)
        const marginX = (pdfWidth - finalWidth) / 2;
        const marginY = 5; // Margem fixa no topo

        pdf.addImage(imgData, 'PNG', marginX, marginY, finalWidth, finalHeight);
        pdf.save(filename);
      }).catch(err => {
        console.error('Erro ao gerar PDF:', err);
        alert('Ocorreu um erro ao gerar o PDF.');
      }).finally(() => {
        this.restoreAfterExport(setupData);
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    },

    /**
     * Gera um nome de arquivo formatado com base no mês e ano atuais da configuração.
     */
    getExportFilename(extension) {
      let title = 'Escala_Frota';
      if (window.Store && window.Store.state.config) {
        const monthNames = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
        const m = monthNames[window.Store.state.config.monthIndex];
        const y = window.Store.state.config.year;
        title = `Escala_${m}_${y}`.replace(/\s+/g, '_');
      }
      return `${title}.${extension}`;
    }
  };

  // Expõe globalmente
  window.PrintManager = PrintManager;

  // Inicia o PrintManager quando o DOM carrega
  document.addEventListener('DOMContentLoaded', () => {
    PrintManager.init();
  });

})();